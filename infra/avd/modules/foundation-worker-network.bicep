// Network Contributor on an existing VNet outside the AVD resource group, so the portal worker can join session hosts
// and the storage private endpoint to its subnets and link the private DNS zone (ADR 0018).
param workerPrincipalId string
param vnetName string

var networkContributorRole = '4d97b98b-1d4f-4787-a291-c67834d212e7'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource networkContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vnet.id, workerPrincipalId, networkContributorRole)
  scope: vnet
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', networkContributorRole)
    description: 'AVD Deploy portal worker: join session hosts and the private endpoint to this network.'
  }
}
