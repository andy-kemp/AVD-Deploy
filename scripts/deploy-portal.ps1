#requires -Version 7.2
<#
.SYNOPSIS
Deploys or updates the whole AVD Deploy portal: Static Web App, app registration, portal worker, and the built site.

.DESCRIPTION
Run as an Owner of the subscription who can also manage app registrations in the tenant (signed in with Connect-AzAccount).
Safe to rerun: it reuses the app registration (by display name) and the Static Web App, so the portal URL stays the same.

  1. Checks Az PowerShell, Node.js and Bicep (downloads the pinned Bicep CLI into .tools if it isn't on PATH).
  2. Registers the resource providers the portal and worker need.
  3. Deploys the Static Web App (infra/portal/static-web-app.bicep).
  4. Creates or updates the single-tenant SPA registration: redirect URIs and delegated permissions (ADR 0017/0018).
     -GrantAdminConsent also grants tenant-wide consent for them (needs Global or Privileged Role Administrator).
  5. Installs or updates the worker (scripts/install-portal-worker.ps1), unless -SkipWorker.
  6. Writes portal/.env.local, builds the portal and publishes it to the Static Web App.

.EXAMPLE
.\scripts\deploy-portal.ps1 -SubscriptionId e4ff0a5a-e3a9-4c45-bd52-40fdb836b214 -GrantAdminConsent
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$ResourceGroupName = 'rg-avddeploy-portal',
    [string]$Location = 'uksouth',
    [string]$StaticWebAppLocation = 'westeurope',
    [string]$StaticWebAppName = 'swa-avddeploy-portal',
    [string]$AppDisplayName = 'AVD Deploy portal',
    [switch]$GrantAdminConsent,
    [switch]$SkipWorker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$portal = Join-Path $root 'portal'

$bicepVersion = 'v0.47.16'
$bicepAssets = @{
    'win-x64'   = @{ Name = 'bicep-win-x64.exe'; Sha256 = '3f343ab1ce41feac156464adee3dc499cb6c197366fc731aed276192011d867c' }
    'linux-x64' = @{ Name = 'bicep-linux-x64'; Sha256 = '64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a' }
}
$swaCliVersion = '2.0.10'
$graphAppId = '00000003-0000-0000-c000-000000000000'
$armAppId = '797f4846-ba00-4fd7-ba43-dac1f8f63013'
$storageAppId = 'e406a681-f3d4-42a8-90b6-c2b029497af1'
$graphScopes = @('User.Read', 'GroupMember.Read.All', 'Group.ReadWrite.All')

function Write-Step { param([string]$Text) Write-Host "`n== $Text" -ForegroundColor Cyan }

function Invoke-Graph {
    param([string]$Method, [string]$Path, $Body)
    $arguments = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path" }
    if ($null -ne $Body) { $arguments.Payload = $Body | ConvertTo-Json -Depth 10 }
    $response = Invoke-AzRestMethod @arguments
    if ($response.StatusCode -ge 300) { throw "Graph $Method $Path returned $($response.StatusCode): $($response.Content)" }
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
}

function Get-ServicePrincipal {
    # First-party service principals are usually present already; create one if this tenant hasn't used the API yet.
    param([string]$AppId)
    $found = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$AppId'&`$select=id,appId,oauth2PermissionScopes").value
    if ($found) { return $found[0] }
    return Invoke-Graph POST '/servicePrincipals' @{ appId = $AppId }
}

function Get-ScopeId {
    param($ServicePrincipal, [string]$Value)
    $scope = $ServicePrincipal.oauth2PermissionScopes | Where-Object value -eq $Value
    if (-not $scope) { throw "Permission $Value was not found on $($ServicePrincipal.appId)." }
    return $scope.id
}

function Install-Bicep {
    $existing = Get-Command bicep -CommandType Application -ErrorAction SilentlyContinue
    if ($existing) { return }
    $platform = if ($IsWindows) { 'win-x64' } elseif ($IsLinux) { 'linux-x64' } else { throw 'Install the Bicep CLI and put it on PATH.' }
    $asset = $bicepAssets[$platform]
    $tools = Join-Path $root '.tools'
    [System.IO.Directory]::CreateDirectory($tools) | Out-Null
    $path = Join-Path $tools $(if ($IsWindows) { 'bicep.exe' } else { 'bicep' })
    if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $asset.Sha256) {
        Write-Host "Downloading Bicep $bicepVersion..."
        Invoke-WebRequest -Uri "https://github.com/Azure/bicep/releases/download/$bicepVersion/$($asset.Name)" -OutFile $path -UseBasicParsing
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $asset.Sha256) { Remove-Item -LiteralPath $path; throw 'The Bicep download failed its SHA-256 check.' }
        if (-not $IsWindows) { & chmod +x $path }
    }
    $env:PATH = "$tools$([System.IO.Path]::PathSeparator)$env:PATH"
}

Write-Step 'Checking prerequisites'
foreach ($command in 'Connect-AzAccount', 'New-AzResourceGroupDeployment', 'npm', 'npx') {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is missing. Install Az PowerShell (Az.Accounts, Az.Resources) and Node.js 20 or later." }
}
Install-Bicep
if (-not (Get-AzContext)) { Connect-AzAccount | Out-Null }
$context = Set-AzContext -Subscription $SubscriptionId
$tenantId = $context.Tenant.Id
Write-Host "Subscription $($context.Subscription.Name) in tenant $tenantId, as $($context.Account.Id)"

Write-Step 'Registering resource providers'
foreach ($namespace in 'Microsoft.Web', 'Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.Storage', 'Microsoft.ManagedIdentity') {
    if ((Get-AzResourceProvider -ProviderNamespace $namespace | Select-Object -First 1).RegistrationState -ne 'Registered') {
        Register-AzResourceProvider -ProviderNamespace $namespace | Out-Null
    }
}
$deadline = [DateTime]::UtcNow.AddMinutes(10)
while ($pending = @('Microsoft.Web', 'Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.Storage', 'Microsoft.ManagedIdentity' |
            Where-Object { (Get-AzResourceProvider -ProviderNamespace $_ | Select-Object -First 1).RegistrationState -ne 'Registered' })) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Providers still registering: $($pending -join ', '). Rerun in a few minutes." }
    Start-Sleep -Seconds 15
}

Write-Step 'Deploying the Static Web App'
if (-not (Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue)) {
    New-AzResourceGroup -Name $ResourceGroupName -Location $Location -Tag @{ purpose = 'avd-deploy-portal' } | Out-Null
}
$site = New-AzResourceGroupDeployment -Name "avddeploy-swa-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))" -ResourceGroupName $ResourceGroupName `
    -TemplateFile (Join-Path $root 'infra/portal/static-web-app.bicep') -TemplateParameterObject @{ location = $StaticWebAppLocation; name = $StaticWebAppName }
if ($site.ProvisioningState -ne 'Succeeded') { throw 'The Static Web App deployment did not succeed.' }
$hostname = $site.Outputs.hostname.Value
$origins = @("https://$hostname", 'http://localhost:5173')
Write-Host "Portal URL: https://$hostname"

Write-Step 'Configuring the app registration'
$graphSp = Get-ServicePrincipal $graphAppId
$armSp = Get-ServicePrincipal $armAppId
$storageSp = Get-ServicePrincipal $storageAppId
$registration = @{
    signInAudience         = 'AzureADMyOrg'
    spa                    = @{ redirectUris = @($origins | ForEach-Object { "$_/redirect.html" }) }
    requiredResourceAccess = @(
        @{ resourceAppId = $graphAppId; resourceAccess = @($graphScopes | ForEach-Object { @{ id = (Get-ScopeId $graphSp $_); type = 'Scope' } }) }
        @{ resourceAppId = $armAppId; resourceAccess = @(@{ id = (Get-ScopeId $armSp 'user_impersonation'); type = 'Scope' }) }
        @{ resourceAppId = $storageAppId; resourceAccess = @(@{ id = (Get-ScopeId $storageSp 'user_impersonation'); type = 'Scope' }) }
    )
}
$app = (Invoke-Graph GET "/applications?`$filter=displayName eq '$($AppDisplayName -replace "'", "''")'&`$select=id,appId").value | Select-Object -First 1
if ($app) {
    Invoke-Graph PATCH "/applications/$($app.id)" $registration | Out-Null
    Write-Host "Updated registration $($app.appId)"
} else {
    $app = Invoke-Graph POST '/applications' ($registration + @{ displayName = $AppDisplayName })
    Write-Host "Created registration $($app.appId)"
}
$appSp = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id").value | Select-Object -First 1
if (-not $appSp) { $appSp = Invoke-Graph POST '/servicePrincipals' @{ appId = $app.appId } }

if ($GrantAdminConsent) {
    Write-Step 'Granting admin consent'
    $grants = @((Invoke-Graph GET "/oauth2PermissionGrants?`$filter=clientId eq '$($appSp.id)'").value)
    foreach ($grant in @(
            @{ Resource = $graphSp; Scope = $graphScopes -join ' ' }
            @{ Resource = $armSp; Scope = 'user_impersonation' }
            @{ Resource = $storageSp; Scope = 'user_impersonation' })) {
        $existing = $grants | Where-Object { $_.resourceId -eq $grant.Resource.id -and $_.consentType -eq 'AllPrincipals' } | Select-Object -First 1
        if ($existing) {
            Invoke-Graph PATCH "/oauth2PermissionGrants/$($existing.id)" @{ scope = $grant.Scope } | Out-Null
        } else {
            Invoke-Graph POST '/oauth2PermissionGrants' @{ clientId = $appSp.id; consentType = 'AllPrincipals'; resourceId = $grant.Resource.id; scope = $grant.Scope } | Out-Null
        }
        Write-Host "Consented: $($grant.Scope) ($($grant.Resource.appId))"
    }
} else {
    Write-Host 'Admin consent not granted. GroupMember.Read.All and Group.ReadWrite.All need it: rerun with -GrantAdminConsent, or grant it in the Entra admin centre.'
}

$environment = [ordered]@{ VITE_AVD_TENANT_ID = $tenantId; VITE_AVD_CLIENT_ID = $app.appId; VITE_AVD_WORKER_STORAGE = ''; VITE_AVD_WORKER_JOB = '' }
if (-not $SkipWorker) {
    Write-Step 'Installing the portal worker'
    $workerOutput = & (Join-Path $PSScriptRoot 'install-portal-worker.ps1') -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -Location $Location -PortalOrigins $origins
    foreach ($line in @($workerOutput)) {
        if ("$line" -match '^(VITE_AVD_WORKER_(?:STORAGE|JOB))=(.+)$') { $environment[$Matches[1]] = $Matches[2] }
    }
    if (-not $environment.VITE_AVD_WORKER_JOB) { throw 'The worker install did not report its storage account and job.' }
}

Write-Step 'Building the portal'
[System.IO.File]::WriteAllText((Join-Path $portal '.env.local'), (($environment.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n") + "`n")
Push-Location $portal
try {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'The portal build failed.' }

    Write-Step 'Publishing the portal'
    $secrets = Invoke-AzRestMethod -Method POST -Path "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Web/staticSites/$StaticWebAppName/listSecrets?api-version=2023-12-01"
    if ($secrets.StatusCode -ne 200) { throw "Reading the Static Web App deployment token returned $($secrets.StatusCode)." }
    # The token goes through an environment variable so it never appears on a command line or in output.
    $env:SWA_CLI_DEPLOYMENT_TOKEN = ($secrets.Content | ConvertFrom-Json).properties.apiKey
    try {
        npx --yes "@azure/static-web-apps-cli@$swaCliVersion" deploy ./dist --env production
        if ($LASTEXITCODE -ne 0) { throw 'Publishing to the Static Web App failed.' }
    } finally {
        Remove-Item Env:SWA_CLI_DEPLOYMENT_TOKEN -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}

Write-Step 'Done'
Write-Host "Portal: https://$hostname"
Write-Host "App registration (client ID): $($app.appId)"
if (-not $SkipWorker) { Write-Host "Worker job: $($environment.VITE_AVD_WORKER_JOB)" }
