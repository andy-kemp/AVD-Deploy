// Rights for the portal worker's managed identity on one AVD resource group (ADR 0018). The operator grants these in
// the foundation, so the worker can deploy the platform and session hosts but never widen its own access.
@description('Object ID of the portal worker managed identity.')
param workerPrincipalId string

var contributorRole = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministratorRole = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
var keyVaultSecretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'

// The only roles the platform templates assign: Desktop Virtualization User, Virtual Machine User Login,
// Virtual Machine Administrator Login, Desktop Virtualization Power On Contributor, and Storage File Data SMB Share
// Contributor / Elevated Contributor for FSLogix. Keep in step with $script:WorkerAssignableRoles in AvdDeployment.psm1
// (Phase1.Tests.ps1 checks both against the templates).
var assignableRoles = '1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63, fb879df8-f326-4884-b1cf-06f3ad86be52, 1c0163c0-47e6-4577-8991-ea5c82e286e4, 489581de-a3bd-480d-9518-53dea7416b33, 0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb, a7264617-510b-434b-a828-9731dc254ea7'
var assignmentCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoles}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoles}}))'

resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, workerPrincipalId, contributorRole)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRole)
    description: 'AVD Deploy portal worker: deploy the AVD platform and session hosts.'
  }
}

resource limitedRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, workerPrincipalId, rbacAdministratorRole)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRole)
    condition: assignmentCondition
    conditionVersion: '2.0'
    description: 'AVD Deploy portal worker: assign only the AVD access roles the platform template needs.'
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, workerPrincipalId, keyVaultSecretsUserRole)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRole)
    description: 'AVD Deploy portal worker: read the session host admin password.'
  }
}
