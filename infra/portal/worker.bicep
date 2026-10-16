// Portal worker (ADR 0018): a manually started Container Apps Job that runs avd.ps1 as a user-assigned managed identity,
// with job inputs, status and results in a private storage account. The operator starts jobs and reads results with
// their own Azure rights; there is no API.
@description('Region for the worker resources.')
param location string = resourceGroup().location
@description('Portal origins allowed to call blob storage from the browser.')
param portalOrigins array
@description('Object ID of the operator who starts jobs and reads their results.')
param operatorObjectId string
@description('Object ID of the Azure Virtual Desktop service principal in this tenant (looked up once, so the worker needs no Graph rights).')
param avdServicePrincipalObjectId string
@description('Code bundle in the releases container and its SHA-256, checked before it runs.')
param bundleName string
param bundleSha256 string
@description('Azure PowerShell image, pinned by digest.')
param image string = 'mcr.microsoft.com/azure-powershell:16.3.0-azurelinux-3.0@sha256:b88208de6a9ceecac4d54afe3c27195c6eba8070adb5fa0460758040f13dc0cc'
param tags object = { purpose: 'avd-deploy-portal' }

var suffix = uniqueString(resourceGroup().id)
var blobDataContributorRole = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource worker 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-avddeploy-worker'
  location: location
  tags: tags
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stavddeploy${take(suffix, 11)}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    // Entra ID only: no account keys or SAS, and nothing anonymous.
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    defaultToOAuthAuthentication: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: portalOrigins
          allowedMethods: ['GET', 'PUT', 'HEAD', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['*']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource jobsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'jobs'
}

resource releasesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'releases'
}

resource retention 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-job-records'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['jobs/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 90 } } }
          }
        }
      ]
    }
  }
}

resource workerBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, worker.id, blobDataContributorRole)
  scope: storage
  properties: {
    principalId: worker.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRole)
  }
}

resource operatorBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, operatorObjectId, blobDataContributorRole)
  scope: storage
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRole)
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-avddeploy-${take(suffix, 6)}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-avddeploy'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

// Downloads the code bundle with the worker identity, checks its SHA-256, then runs scripts/portal-worker.ps1.
var bootstrap = join([
  '$ErrorActionPreference = \'Stop\''
  'Connect-AzAccount -Identity -AccountId $env:AZURE_CLIENT_ID | Out-Null'
  '$context = New-AzStorageContext -StorageAccountName $env:STORAGE_ACCOUNT -UseConnectedAccount'
  'Get-AzStorageBlobContent -Context $context -Container releases -Blob $env:BUNDLE_NAME -Destination /tmp/bundle.zip -Force | Out-Null'
  'if ((Get-FileHash /tmp/bundle.zip -Algorithm SHA256).Hash -ne $env:BUNDLE_SHA256) { throw \'Code bundle failed its SHA-256 check.\' }'
  'Expand-Archive /tmp/bundle.zip /tmp/app -Force'
  '& /tmp/app/scripts/portal-worker.ps1'
], '; ')

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-avddeploy-worker'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${worker.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      // Deploy waits for host registration and restarts; allow three hours, and never retry a half-run deployment.
      replicaTimeout: 10800
      replicaRetryLimit: 0
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: ['pwsh', '-NoProfile', '-NonInteractive', '-Command', bootstrap]
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'AZURE_CLIENT_ID', value: worker.properties.clientId }
            { name: 'WORKER_PRINCIPAL_ID', value: worker.properties.principalId }
            { name: 'AVD_SP_OBJECT_ID', value: avdServicePrincipalObjectId }
            { name: 'STORAGE_ACCOUNT', value: storage.name }
            { name: 'BUNDLE_NAME', value: bundleName }
            { name: 'BUNDLE_SHA256', value: bundleSha256 }
            { name: 'JOB_ID', value: '' }
            { name: 'JOB_ACTION', value: '' }
            { name: 'APPROVE', value: '' }
          ]
        }
      ]
    }
  }
  dependsOn: [workerBlobAccess]
}

output storageAccountName string = storage.name
output jobResourceId string = job.id
output workerPrincipalId string = worker.properties.principalId
