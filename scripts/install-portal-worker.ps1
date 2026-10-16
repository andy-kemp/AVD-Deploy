#requires -Version 7.2
<#
.SYNOPSIS
Installs or updates the portal worker (ADR 0018): storage, Container Apps Job and its managed identity.

.DESCRIPTION
Run as the operator (Owner on the subscription). It packages avd.ps1 and its modules, templates and contracts into a
code bundle, deploys infra/portal/worker.bicep, gives the worker Reader on the subscription, and uploads the bundle.
Rerun after changing the PowerShell or Bicep code so the job runs the new bundle. Prints the values the portal build needs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$ResourceGroupName = 'rg-avddeploy-portal',
    [string]$Location = 'uksouth',
    [Parameter(Mandatory)][string[]]$PortalOrigins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if (-not (Get-Command bicep -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Install the Bicep CLI and put it on PATH.' }
Set-AzContext -Subscription $SubscriptionId | Out-Null
$operator = Get-AzADUser -SignedIn
$avdPrincipal = @(Get-AzADServicePrincipal -ApplicationId '9cdead84-a844-4324-93f2-b2e6bb768d07')
if ($avdPrincipal.Count -ne 1) { throw 'The Azure Virtual Desktop service principal was not found. Register Microsoft.DesktopVirtualization first.' }

# Code bundle: only what the worker runs. sandbox/ (real tenant IDs) and the portal are never included.
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "avd-bundle-$([guid]::NewGuid().ToString('N'))"
$bundlePath = "$staging.zip"
try {
    [System.IO.Directory]::CreateDirectory($staging) | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'avd.ps1') -Destination $staging
    foreach ($folder in 'lib', 'infra', 'contracts', 'config', 'scripts') {
        Copy-Item -LiteralPath (Join-Path $root $folder) -Destination $staging -Recurse
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $bundlePath)
    $sha = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $bundleName = "avd-deploy-$($sha.Substring(0, 12)).zip"
    Write-Host "Code bundle $bundleName ($sha)"

    if (-not (Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue)) {
        New-AzResourceGroup -Name $ResourceGroupName -Location $Location -Tag @{ purpose = 'avd-deploy-portal' } | Out-Null
    }
    Write-Host 'Deploying the worker resources...'
    $deployment = New-AzResourceGroupDeployment -Name "avddeploy-worker-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))" -ResourceGroupName $ResourceGroupName `
        -TemplateFile (Join-Path $root 'infra/portal/worker.bicep') -TemplateParameterObject @{
            location                    = $Location
            portalOrigins               = $PortalOrigins
            operatorObjectId            = $operator.Id
            avdServicePrincipalObjectId = $avdPrincipal[0].Id
            bundleName                  = $bundleName
            bundleSha256                = $sha
        }
    if ($deployment.ProvisioningState -ne 'Succeeded') { throw 'The worker deployment did not succeed.' }
    $outputs = $deployment.Outputs
    New-AzDeployment -Name "avddeploy-worker-reader-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))" -Location $Location `
        -TemplateFile (Join-Path $root 'infra/portal/worker-subscription.bicep') -TemplateParameterObject @{ workerPrincipalId = $outputs.workerPrincipalId.Value } | Out-Null

    # Upload with the operator's Entra token; the account has no keys. A new data role can take a few minutes to apply.
    $account = $outputs.storageAccountName.Value
    $uri = "https://$account.blob.core.windows.net/releases/$bundleName"
    $bytes = [System.IO.File]::ReadAllBytes($bundlePath)
    for ($attempt = 1; ; $attempt++) {
        $token = (Get-AzAccessToken -ResourceUrl 'https://storage.azure.com/' -AsSecureString).Token | ConvertFrom-SecureString -AsPlainText
        $response = Invoke-WebRequest -Method PUT -Uri $uri -Body $bytes -ContentType 'application/zip' -SkipHttpErrorCheck -UseBasicParsing -Headers @{
            Authorization = "Bearer $token"; 'x-ms-version' = '2023-11-03'; 'x-ms-blob-type' = 'BlockBlob'
        }
        if ($response.StatusCode -eq 201) { break }
        if ($response.StatusCode -ne 403 -or $attempt -ge 20) { throw "Uploading the code bundle returned HTTP $($response.StatusCode)." }
        Write-Host 'Waiting for storage access to apply...'
        Start-Sleep -Seconds 30
    }
    Write-Host 'Code bundle uploaded.'
    Write-Output "VITE_AVD_WORKER_STORAGE=$account"
    Write-Output "VITE_AVD_WORKER_JOB=$($outputs.jobResourceId.Value)"
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $bundlePath -Force -ErrorAction SilentlyContinue
}
