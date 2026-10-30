// Session hosts with the local admin password read from the foundation's Key Vault through an ARM Key Vault reference,
// for the browser deployer at deploy.andykemp.com/avd (akc-tools ADR 0004). The password never passes through the
// caller: ARM resolves it inside Azure. Needs the vault's enabledForTemplateDeployment (set by the foundation) and
// Microsoft.KeyVault/vaults/deploy/action for whoever deploys (Contributor and Owner include it).
// The CLI keeps calling session-hosts.bicep directly with the password it read.

@description('Foundation Key Vault holding the session host admin password.')
param keyVaultName string
@description('Secret name of the session host admin password.')
param adminPasswordSecretName string = 'sessionhost-admin'
param sessionHostPrefix string
param hostPoolName string
param vmSize string
@minValue(1)
@maxValue(100)
param numberOfHosts int
param adminUsername string
@secure()
@description('Temporary registration token created for this host-pool operation.')
param hostPoolRegistrationInfoToken string
param vNetResourceGroup string
param vNetName string
param subnetName string
param storageAccountName string = ''
param dns1 string = ''
param dns2 string = ''
param sessionHostPrepScriptUrl string
@allowed(['Pooled', 'Personal'])
param hostPoolType string = 'Pooled'
@allowed(['FSLogix', 'Local'])
param profileMode string = 'FSLogix'
param preventTempProfile bool = false
param imageOffer string = 'Windows-11'
param imageSku string = ''

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

module hosts './session-hosts.bicep' = {
  name: 'session-hosts'
  params: {
    sessionHostPrefix: sessionHostPrefix
    hostPoolName: hostPoolName
    vmSize: vmSize
    numberOfHosts: numberOfHosts
    adminUsername: adminUsername
    adminPassword: vault.getSecret(adminPasswordSecretName)
    hostPoolRegistrationInfoToken: hostPoolRegistrationInfoToken
    vNetResourceGroup: vNetResourceGroup
    vNetName: vNetName
    subnetName: subnetName
    storageAccountName: storageAccountName
    dns1: dns1
    dns2: dns2
    sessionHostPrepScriptUrl: sessionHostPrepScriptUrl
    hostPoolType: hostPoolType
    profileMode: profileMode
    preventTempProfile: preventTempProfile
    imageOffer: imageOffer
    imageSku: imageSku
  }
}

output sessionHostNames array = hosts.outputs.sessionHostNames
