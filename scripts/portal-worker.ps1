#requires -Version 7.2
# Portal worker (ADR 0018). Runs in the Container Apps Job as the worker's managed identity, after the job command has
# downloaded and hash-checked this bundle. Reads the job's inputs from blob storage and writes status, log and results back.
#
#   preview: generate the configuration from the portal's answers (first run only), then write the foundation request
#            and run Preview. Rerun after the operator prepares the foundation.
#   deploy:  run Deploy against the saved configuration and plan, approved with the resource group name.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bicepVersion = 'v0.47.16'
$bicepSha256 = '64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a'
$guid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

$jobId = [string]$env:JOB_ID
$action = [string]$env:JOB_ACTION
if ($jobId -notmatch $guid) { throw 'JOB_ID must be a GUID.' }
if ($action -notin 'preview', 'deploy') { throw 'JOB_ACTION must be preview or deploy.' }
foreach ($name in 'STORAGE_ACCOUNT', 'WORKER_PRINCIPAL_ID', 'AVD_SP_OBJECT_ID') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set." }
}

$appRoot = Split-Path $PSScriptRoot -Parent
$cli = Join-Path $appRoot 'avd.ps1'
$work = Join-Path ([System.IO.Path]::GetTempPath()) "avd-$jobId"
[System.IO.Directory]::CreateDirectory($work) | Out-Null
$files = @{
    answers    = Join-Path $work 'answers.json'
    config     = Join-Path $work 'config.json'
    plan       = Join-Path $work 'config.plan.json'
    foundation = Join-Path $work 'foundation.json'
    status     = Join-Path $work 'status.json'
    log        = Join-Path $work 'log.txt'
}
$storage = New-AzStorageContext -StorageAccountName $env:STORAGE_ACCOUNT -UseConnectedAccount
$container = 'jobs'

function Save-Blob {
    param([string]$Path, [string]$Name)
    Set-AzStorageBlobContent -Context $storage -Container $container -Blob "$jobId/$Name" -File $Path -Properties @{ ContentType = 'application/json; charset=utf-8' } -Force | Out-Null
}

function Get-Blob {
    param([string]$Name, [string]$Path, [switch]$Optional)
    try {
        Get-AzStorageBlobContent -Context $storage -Container $container -Blob "$jobId/$Name" -Destination $Path -Force -ErrorAction Stop | Out-Null
        return $true
    } catch {
        if ($Optional) { return $false }
        throw "Job input $Name was not found."
    }
}

$log = [System.Text.StringBuilder]::new()
$lastFlush = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Log {
    param([string]$Line, [switch]$Flush)
    if ($null -ne $Line) {
        $null = $log.AppendLine("[$([DateTime]::UtcNow.ToString('HH:mm:ss'))] $Line")
        Write-Host $Line
    }
    if ($Flush -or $lastFlush.Elapsed.TotalSeconds -ge 15) {
        [System.IO.File]::WriteAllText($files.log, $log.ToString())
        Set-AzStorageBlobContent -Context $storage -Container $container -Blob "$jobId/log.txt" -File $files.log -Properties @{ ContentType = 'text/plain; charset=utf-8' } -Force | Out-Null
        $lastFlush.Restart()
    }
}

$status = [ordered]@{ jobId = $jobId; action = $action; state = 'running'; stage = 'starting'; startedUtc = [DateTime]::UtcNow.ToString('o'); updatedUtc = ''; message = '' }
function Set-Status {
    param([string]$State, [string]$Stage, [string]$Message, [hashtable]$Extra = @{})
    if ($State) { $status.state = $State }
    if ($Stage) { $status.stage = $Stage }
    if ($PSBoundParameters.ContainsKey('Message')) { $status.message = $Message }
    foreach ($key in $Extra.Keys) { $status[$key] = $Extra[$key] }
    $status.updatedUtc = [DateTime]::UtcNow.ToString('o')
    [System.IO.File]::WriteAllText($files.status, ($status | ConvertTo-Json -Depth 6))
    Save-Blob -Path $files.status -Name 'status.json'
    Write-Log "Status: $($status.state) / $($status.stage)$(if ($status.message) { " - $($status.message)" })" -Flush
}

function Invoke-Cli {
    # Runs avd.ps1 in this process and streams its output into the job log.
    param([string]$Stage, [hashtable]$Arguments)
    Set-Status -Stage $Stage -Message ''
    $output = [System.Collections.Generic.List[string]]::new()
    & $cli @Arguments *>&1 | ForEach-Object {
        $text = if ($_ -is [System.Management.Automation.InformationRecord]) { [string]$_.MessageData }
        elseif ($_ -is [System.Management.Automation.ErrorRecord]) { "ERROR: $($_.Exception.Message)" }
        else { ($_ | Out-String).TrimEnd() }
        $output.Add($text)
        Write-Log $text
    }
    return $output
}

function Use-Subscription {
    param([string]$SubscriptionId)
    try {
        Set-AzContext -Subscription $SubscriptionId -ErrorAction Stop | Out-Null
    } catch {
        throw "The portal worker cannot read subscription $SubscriptionId. Give id-avddeploy-worker Reader on it (the portal offers this when you choose the subscription), then run Preview again."
    }
}

function Install-Bicep {
    $bin = Join-Path $work 'bin'
    [System.IO.Directory]::CreateDirectory($bin) | Out-Null
    $path = Join-Path $bin 'bicep'
    Invoke-WebRequest -Uri "https://github.com/Azure/bicep/releases/download/$bicepVersion/bicep-linux-x64" -OutFile $path -UseBasicParsing
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bicepSha256) { throw "Bicep $bicepVersion failed its SHA-256 check." }
    & chmod +x $path
    $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$env:PATH"
}

try {
    Set-Status -State 'running' -Stage 'setup'
    Install-Bicep

    if ($action -eq 'preview') {
        $null = Get-Blob -Name 'answers.json' -Path $files.answers
        $answers = Get-Content -LiteralPath $files.answers -Raw | ConvertFrom-Json
        Use-Subscription -SubscriptionId $answers.SubscriptionId
        if (Get-Blob -Name 'config.json' -Path $files.config -Optional) {
            Write-Log 'Using the configuration generated by the first Preview of this job.'
        } else {
            $null = Invoke-Cli -Stage 'configuration' -Arguments @{ Mode = 'New'; AnswersFile = $files.answers; OutputFile = $files.config; PortalWorker = $true; AvdServicePrincipalObjectId = $env:AVD_SP_OBJECT_ID; Force = $true }
            Save-Blob -Path $files.config -Name 'config.json'
        }
        $null = Invoke-Cli -Stage 'foundation-check' -Arguments @{ Mode = 'Foundation'; ConfigurationFile = $files.config; OutputFile = $files.foundation; WorkerPrincipalObjectId = $env:WORKER_PRINCIPAL_ID }
        Save-Blob -Path $files.foundation -Name 'foundation.json'
        $foundation = Get-Content -LiteralPath $files.foundation -Raw | ConvertFrom-Json
        $null = Invoke-Cli -Stage 'preview' -Arguments @{ Mode = 'Preview'; ConfigurationFile = $files.config; PlanFile = $files.plan }
        Save-Blob -Path $files.plan -Name 'plan.json'
        $plan = Get-Content -LiteralPath $files.plan -Raw | ConvertFrom-Json
        $ready = -not $foundation.needed -and @($plan.blockers).Count -eq 0
        Set-Status -State 'previewed' -Stage 'done' -Message $(if ($ready) { 'Ready to deploy.' } elseif ($foundation.needed) { 'Prepare the foundation, then run Preview again.' } else { 'Preview found blockers.' }) -Extra @{
            ready = $ready; needsFoundation = [bool]$foundation.needed; resourceGroup = [string]$plan.resourceGroup; planExpiresUtc = [string]$plan.expiresUtc
        }
    } else {
        $null = Get-Blob -Name 'config.json' -Path $files.config
        $null = Get-Blob -Name 'plan.json' -Path $files.plan
        $configuration = Get-Content -LiteralPath $files.config -Raw | ConvertFrom-Json
        if ([string]$env:APPROVE -cne [string]$configuration.target.resourceGroupName) { throw 'Deployment not approved: APPROVE must equal the resource group name.' }
        Use-Subscription -SubscriptionId $configuration.subscriptionId
        $output = Invoke-Cli -Stage 'deploy' -Arguments @{ Mode = 'Deploy'; ConfigurationFile = $files.config; PlanFile = $files.plan; Approve = $env:APPROVE }
        $index = $output.IndexOf('Still to do (manual):')
        # The CLI's PostDeploy hint names this container's path; the portal shows the command for the downloaded file instead.
        $manual = if ($index -ge 0) { @($output | Select-Object -Skip ($index + 1) | ForEach-Object { $_.Trim() -replace '^- ', '' } | Where-Object { $_ -and $_ -notmatch '^Run \.\\avd\.ps1 -Mode PostDeploy' }) } else { @() }
        Set-Status -State 'deployed' -Stage 'done' -Message 'Deployment finished.' -Extra @{ resourceGroup = [string]$configuration.target.resourceGroupName; manualTasks = $manual }
    }
} catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    Set-Status -State 'failed' -Message $_.Exception.Message
    exit 1
} finally {
    Write-Log $null -Flush
}
