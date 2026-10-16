#requires -Version 7.2
<#
.SYNOPSIS
Deploys or updates the hosted AVD Deploy service: Static Web App (Standard), API Container App and its storage,
and the front end, at https://avd-deploy.andykemp.com (ADR 0017/0018).

.DESCRIPTION
Run as an Owner of the subscription, signed in with Connect-AzAccount, with Node.js 24 installed. Safe to rerun after
code changes: each API bundle has its own name and SHA-256, so the Container App gets a new revision.

  1. Moves the Static Web App to the Standard plan (needed for a linked API).
  2. Bundles the API into one file (api/, esbuild) and deploys infra/portal/api.bicep in two passes: storage and
     identity first, then the bundle upload, then the Container App and the /api link.
  3. Builds portal/app with the production Clerk key and publishes it to the Static Web App.
  4. Checks https://<domain>/api/health.

No secrets are involved: the Clerk publishable key is public and the API reaches storage with its managed identity.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = 'e4ff0a5a-e3a9-4c45-bd52-40fdb836b214',
    [string]$ResourceGroupName = 'rg-avddeploy-portal',
    [string]$Location = 'uksouth',
    [string]$StaticWebAppName = 'swa-avddeploy-portal',
    [string]$StaticWebAppLocation = 'westeurope',
    [string]$PortalOrigin = 'https://avd-deploy.andykemp.com',
    [string]$ClerkPublishableKey = 'pk_live_Y2xlcmsuYW5keWtlbXAuY29tJA',
    [string[]]$AkcAdminUserIds = @('user_3C1cZGKKhAyL2R7CZTMais1rUVp'),
    # Client ID printed by create-entra-app.ps1. Turns on Connect tenant.
    [ValidatePattern('^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$EntraClientId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$bicepVersion = 'v0.47.16'
$bicepSha256 = @{ 'win-x64' = '3f343ab1ce41feac156464adee3dc499cb6c197366fc731aed276192011d867c'; 'linux-x64' = '64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a' }
$swaCliVersion = '2.0.10'

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Invoke-Npm { param([string]$Folder, [string[]]$Arguments) Push-Location $Folder; try { & npm @Arguments; if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed in $Folder." } } finally { Pop-Location } }
function Stamp { [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') }

Write-Step 'Checking prerequisites'
foreach ($command in 'New-AzResourceGroupDeployment', 'npm', 'npx', 'node') {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is missing. Install Az PowerShell and Node.js 24." }
}
if (-not (Get-Command bicep -CommandType Application -ErrorAction SilentlyContinue)) {
    $platform = if ($IsWindows) { 'win-x64' } elseif ($IsLinux) { 'linux-x64' } else { throw 'Install the Bicep CLI and put it on PATH.' }
    $tools = Join-Path $root '.tools'
    [System.IO.Directory]::CreateDirectory($tools) | Out-Null
    $bicep = Join-Path $tools $(if ($IsWindows) { 'bicep.exe' } else { 'bicep' })
    if (-not (Test-Path -LiteralPath $bicep) -or (Get-FileHash -LiteralPath $bicep -Algorithm SHA256).Hash -ne $bicepSha256[$platform]) {
        $asset = if ($IsWindows) { 'bicep-win-x64.exe' } else { 'bicep-linux-x64' }
        Invoke-WebRequest -Uri "https://github.com/Azure/bicep/releases/download/$bicepVersion/$asset" -OutFile $bicep -UseBasicParsing
        if ((Get-FileHash -LiteralPath $bicep -Algorithm SHA256).Hash -ne $bicepSha256[$platform]) { Remove-Item -LiteralPath $bicep; throw 'The Bicep download failed its SHA-256 check.' }
        if (-not $IsWindows) { & chmod +x $bicep }
    }
    $env:PATH = "$tools$([System.IO.Path]::PathSeparator)$env:PATH"
}
$context = Set-AzContext -Subscription $SubscriptionId
$operator = Get-AzADUser -SignedIn
Write-Host "Subscription $($context.Subscription.Name), as $($context.Account.Id)"

Write-Step 'Moving the Static Web App to the Standard plan'
$site = New-AzResourceGroupDeployment -Name "avddeploy-swa-$(Stamp)" -ResourceGroupName $ResourceGroupName -TemplateFile (Join-Path $root 'infra/portal/static-web-app.bicep') `
    -TemplateParameterObject @{ location = $StaticWebAppLocation; name = $StaticWebAppName; skuName = 'Standard' }
if ($site.ProvisioningState -ne 'Succeeded') { throw 'The Static Web App deployment did not succeed.' }

Write-Step 'Bundling the API'
$api = Join-Path $root 'api'
Invoke-Npm $api @('ci', '--no-audit', '--no-fund')
Invoke-Npm $api @('test')
Invoke-Npm $api @('run', 'bundle')
$bundlePath = Join-Path $api 'dist/server.mjs'
$sha = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
$bundleName = "api-$($sha.Substring(0, 12)).mjs"
Write-Host "Bundle $bundleName ($sha)"

$apiParameters = @{
    location            = $Location
    environmentName     = 'cae-avddeploy'
    staticWebAppName    = $StaticWebAppName
    operatorObjectId    = $operator.Id
    clerkPublishableKey = $ClerkPublishableKey
    authorizedParties   = @($PortalOrigin)
    akcAdminUserIds     = $AkcAdminUserIds
    entraClientId       = $EntraClientId
    portalOrigin        = $PortalOrigin
}

Write-Step 'Deploying API storage and identity'
$first = New-AzResourceGroupDeployment -Name "avddeploy-api-base-$(Stamp)" -ResourceGroupName $ResourceGroupName -TemplateFile (Join-Path $root 'infra/portal/api.bicep') `
    -TemplateParameterObject ($apiParameters + @{ deployApp = $false })
if ($first.ProvisioningState -ne 'Succeeded') { throw 'The API storage deployment did not succeed.' }
$account = $first.Outputs.storageAccountName.Value

Write-Step 'Uploading the API bundle'
# The account has no keys; upload with the operator's Entra token. A new data role can take a few minutes to apply.
$bytes = [System.IO.File]::ReadAllBytes($bundlePath)
for ($attempt = 1; ; $attempt++) {
    $token = (Get-AzAccessToken -ResourceUrl 'https://storage.azure.com/' -AsSecureString).Token | ConvertFrom-SecureString -AsPlainText
    $response = Invoke-WebRequest -Method PUT -Uri "https://$account.blob.core.windows.net/releases/$bundleName" -Body $bytes -ContentType 'text/javascript' -SkipHttpErrorCheck -UseBasicParsing -Headers @{
        Authorization = "Bearer $token"; 'x-ms-version' = '2023-11-03'; 'x-ms-blob-type' = 'BlockBlob'
    }
    if ($response.StatusCode -eq 201) { break }
    if ($response.StatusCode -ne 403 -or $attempt -ge 20) { throw "Uploading the API bundle returned HTTP $($response.StatusCode)." }
    Write-Host 'Waiting for storage access to apply...'
    Start-Sleep -Seconds 30
}

Write-Step 'Deploying the API and linking it to the Static Web App'
$second = New-AzResourceGroupDeployment -Name "avddeploy-api-$(Stamp)" -ResourceGroupName $ResourceGroupName -TemplateFile (Join-Path $root 'infra/portal/api.bicep') `
    -TemplateParameterObject ($apiParameters + @{ deployApp = $true; bundleName = $bundleName; bundleSha256 = $sha })
if ($second.ProvisioningState -ne 'Succeeded') { throw 'The API deployment did not succeed.' }

Write-Step 'Building and publishing the front end'
$app = Join-Path $root 'portal/app'
Invoke-Npm $app @('ci', '--no-audit', '--no-fund')
# An environment variable beats portal/app/.env.local, so a developer's pk_test key there is left alone.
$env:VITE_CLERK_PUBLISHABLE_KEY = $ClerkPublishableKey
try { Invoke-Npm $app @('run', 'build') } finally { $env:VITE_CLERK_PUBLISHABLE_KEY = $null }
$secrets = Invoke-AzRestMethod -Method POST -Path "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Web/staticSites/$StaticWebAppName/listSecrets?api-version=2023-12-01"
if ($secrets.StatusCode -ne 200) { throw "Reading the Static Web App deployment token returned $($secrets.StatusCode)." }
# The token goes through an environment variable so it never appears on a command line or in output.
$env:SWA_CLI_DEPLOYMENT_TOKEN = ($secrets.Content | ConvertFrom-Json).properties.apiKey
Push-Location $app
try {
    npx --yes "@azure/static-web-apps-cli@$swaCliVersion" deploy ./dist --swa-config-location ./dist --env production
    if ($LASTEXITCODE -ne 0) { throw 'Publishing to the Static Web App failed.' }
} finally {
    $env:SWA_CLI_DEPLOYMENT_TOKEN = $null
    Pop-Location
}

Write-Step 'Checking the API through the portal domain'
# The API scales to zero, so the first request can take a little while.
$healthy = $false
for ($attempt = 1; $attempt -le 12 -and -not $healthy; $attempt++) {
    $health = Invoke-WebRequest -Uri "$PortalOrigin/api/health" -SkipHttpErrorCheck -UseBasicParsing -TimeoutSec 30
    $healthy = $health.StatusCode -eq 200 -and $health.Content -match '"ok":true'
    if (-not $healthy) { Start-Sleep -Seconds 10 }
}
if (-not $healthy) { Write-Warning "$PortalOrigin/api/health did not answer yet; check the Container App's log stream." }

Write-Step 'Done'
Write-Host "Portal: $PortalOrigin"
Write-Host "API health: $(if ($healthy) { 'OK' } else { 'not yet' })"
