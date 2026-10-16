#requires -Version 7.2
<#
.SYNOPSIS
Creates or updates the multi-tenant "AKC AVD Deploy" app that customers approve to connect their tenant (ADR 0018/0019).

.DESCRIPTION
Run as someone who can manage app registrations in AKC's tenant (Application Administrator or higher), signed in with
Connect-AzAccount to the subscription that holds the API. Safe to rerun.

  - Multi-tenant web app with the Connect tenant redirect URIs (/connect/callback after admin consent, /connect/verify
    after the proof sign-in).
  - Delegated permissions for connecting and discovery only: sign-in, User.Read, User.ReadBasic.All,
    GroupMember.Read.All, Application.Read.All and Azure Resource Manager user_impersonation. The post-deploy
    permissions (Conditional Access, app consent, RDP settings) get their own consent step later.
  - Directory roles in tokens (groupMembershipClaims = DirectoryRole), so the API can check the person connecting is an
    administrator who can grant consent.
  - No client secret: the API's managed identity (id-avddeploy-api) is a federated identity credential on the app.

Prints the client ID to pass to deploy-hosted.ps1 -EntraClientId.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = 'e4ff0a5a-e3a9-4c45-bd52-40fdb836b214',
    [string]$ResourceGroupName = 'rg-avddeploy-portal',
    [string]$ApiIdentityName = 'id-avddeploy-api',
    [string]$DisplayName = 'AKC AVD Deploy',
    [string]$PortalOrigin = 'https://avd-deploy.andykemp.com',
    # Also allow http://localhost:3000 for local development.
    [switch]$IncludeLocalhost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$graphAppId = '00000003-0000-0000-c000-000000000000'
$armAppId = '797f4846-ba00-4fd7-ba43-dac1f8f63013'
$graphScopes = @('openid', 'profile', 'offline_access', 'User.Read', 'User.ReadBasic.All', 'GroupMember.Read.All', 'Application.Read.All')

function Invoke-Graph {
    param([string]$Method, [string]$Path, $Body)
    $arguments = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path" }
    if ($null -ne $Body) { $arguments.Payload = $Body | ConvertTo-Json -Depth 10 }
    $response = Invoke-AzRestMethod @arguments
    if ($response.StatusCode -ge 300) { throw "Graph $Method $Path returned $($response.StatusCode): $($response.Content)" }
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
}

$context = Set-AzContext -Subscription $SubscriptionId
$tenantId = $context.Tenant.Id

# The API's managed identity becomes the app's only credential.
$identityPath = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$($ApiIdentityName)?api-version=2023-01-31"
$identityResponse = Invoke-AzRestMethod -Method GET -Path $identityPath
if ($identityResponse.StatusCode -ne 200) { throw "Managed identity $ApiIdentityName was not found in $ResourceGroupName. Run deploy-hosted.ps1 first." }
$apiPrincipalId = ($identityResponse.Content | ConvertFrom-Json).properties.principalId

$graph = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$graphAppId'&`$select=id,oauth2PermissionScopes").value[0]
$arm = (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$armAppId'&`$select=id,oauth2PermissionScopes").value[0]
$scopeId = { param($sp, $value) ($sp.oauth2PermissionScopes | Where-Object value -eq $value).id }

$origins = @($PortalOrigin.TrimEnd('/')) + @(if ($IncludeLocalhost) { 'http://localhost:3000' })
$registration = @{
    displayName            = $DisplayName
    signInAudience         = 'AzureADMultipleOrgs'
    groupMembershipClaims  = 'DirectoryRole'
    web                    = @{
        redirectUris          = @($origins | ForEach-Object { "$_/connect/callback"; "$_/connect/verify" })
        implicitGrantSettings = @{ enableIdTokenIssuance = $false; enableAccessTokenIssuance = $false }
    }
    info                   = @{ marketingUrl = $PortalOrigin; supportUrl = 'https://www.andykemp.com/book-discovery-call/'; privacyStatementUrl = 'https://www.andykemp.com/privacy/' }
    requiredResourceAccess = @(
        @{ resourceAppId = $graphAppId; resourceAccess = @($graphScopes | ForEach-Object { @{ id = (& $scopeId $graph $_); type = 'Scope' } }) }
        @{ resourceAppId = $armAppId; resourceAccess = @(@{ id = (& $scopeId $arm 'user_impersonation'); type = 'Scope' }) }
    )
}

$app = (Invoke-Graph GET "/applications?`$filter=displayName eq '$($DisplayName -replace "'", "''")'&`$select=id,appId").value | Select-Object -First 1
if ($app) {
    Invoke-Graph PATCH "/applications/$($app.id)" $registration | Out-Null
    Write-Host "Updated $DisplayName ($($app.appId))"
} else {
    $app = Invoke-Graph POST '/applications' $registration
    Write-Host "Created $DisplayName ($($app.appId))"
}
if (-not (Invoke-Graph GET "/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id").value) {
    Invoke-Graph POST '/servicePrincipals' @{ appId = $app.appId } | Out-Null
}

$credentialName = 'avddeploy-api-managed-identity'
$existing = (Invoke-Graph GET "/applications/$($app.id)/federatedIdentityCredentials").value | Where-Object name -eq $credentialName
$credential = @{
    name        = $credentialName
    issuer      = "https://login.microsoftonline.com/$tenantId/v2.0"
    subject     = $apiPrincipalId
    audiences   = @('api://AzureADTokenExchange')
    description = "AVD Deploy API managed identity ($ApiIdentityName); no client secret."
}
if ($existing) {
    $update = $credential.Clone()
    $update.Remove('name')   # A credential's name can't be changed.
    Invoke-Graph PATCH "/applications/$($app.id)/federatedIdentityCredentials/$($existing.id)" $update | Out-Null
} else {
    Invoke-Graph POST "/applications/$($app.id)/federatedIdentityCredentials" $credential | Out-Null
}
Write-Host "Federated credential: $ApiIdentityName ($apiPrincipalId)"

Write-Output ''
Write-Output "Client ID: $($app.appId)"
Write-Output "Next: .\scripts\deploy-hosted.ps1 -EntraClientId $($app.appId)"
