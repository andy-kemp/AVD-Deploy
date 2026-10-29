# Sets the FSLogix-recommended permissions on the profiles and redirections share roots, from inside the customer's
# network. The browser deployer (deploy.andykemp.com/avd, akc-tools ADR 0004) runs it as a Run Command on one session
# host, after granting that VM's managed identity 'Storage File Data Privileged Contributor' on the storage account for
# the duration. It reaches the shares through the private endpoint, so the storage firewall is never opened (the CLI's
# PostDeploy opens it to the operator's public IP instead). Same SDDL and Files REST call as lib/AvdPostDeploy.psm1.
# Runs under Windows PowerShell 5.1. Writes one line per share; exits non-zero on failure.
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{3,24}$')][string]$StorageAccountName,
    [Parameter(Mandatory)][ValidatePattern('^S-1-[0-9-]+$')][string]$UsersSid,
    [Parameter(Mandatory)][ValidatePattern('^S-1-[0-9-]+$')][string]$AdminsSid,
    [ValidateRange(1, 60)][int]$Attempts = 30
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-ShareSddl {
    param([string]$Share)
    # Users may create their own folder (this folder only), CREATOR OWNER gets Modify on what they create, admins get
    # Full Control. No inherited or default Authenticated Users access.
    $modify = '0x1301bf'
    $readExecute = '0x1200a9'
    $common = "(A;OICI;FA;;;$AdminsSid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    if ($Share -eq 'profiles') { return "O:BAG:SYD:P(A;OICIIO;$modify;;;CO)(A;;$modify;;;$UsersSid)$common" }
    return "O:BAG:SYD:P(A;OICI;$readExecute;;;$UsersSid)$common"
}

function Get-StorageToken {
    $uri = 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F'
    return (Invoke-RestMethod -Uri $uri -Headers @{ Metadata = 'true' } -UseBasicParsing).access_token
}

foreach ($share in 'profiles', 'redirections') {
    for ($attempt = 1; ; $attempt++) {
        try {
            # A fresh token each attempt: the temporary role assignment can take minutes to reach the data plane.
            $headers = @{
                Authorization              = "Bearer $(Get-StorageToken)"
                'x-ms-version'             = '2024-08-04'
                'x-ms-date'                = [DateTime]::UtcNow.ToString('R')
                'x-ms-file-request-intent' = 'backup'
                'x-ms-file-permission'     = (Get-ShareSddl -Share $share)
            }
            Invoke-WebRequest -Method PUT -Uri "https://$StorageAccountName.file.core.windows.net/$share`?restype=directory&comp=properties" -Headers $headers -UseBasicParsing | Out-Null
            Write-Output "OK $share"
            break
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if (($status -ne 403 -and $status -ne 0) -or $attempt -ge $Attempts) {
                Write-Output "FAILED $share (HTTP $status): $($_.Exception.Message)"
                exit 1
            }
            Start-Sleep -Seconds 20
        }
    }
}
