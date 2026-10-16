// The portal worker reads the subscription to generate configurations and run Preview (ADR 0018). Everything it changes
// is granted per AVD resource group by the operator's foundation deployment.
targetScope = 'subscription'

param workerPrincipalId string

var readerRole = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, workerPrincipalId, readerRole)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRole)
    description: 'AVD Deploy portal worker: discovery and Preview.'
  }
}
