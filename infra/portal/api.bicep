// Hosted API for AVD Deploy (ADR 0017/0018): a Container App linked to the Static Web App as its /api backend, with
// control-plane state in Table Storage. The API reaches storage with its own managed identity; there are no keys or
// secrets. It runs a single-file bundle from the releases container whose SHA-256 is fixed here, so a new revision is
// created whenever the bundle changes.
@description('Region for the API and its storage.')
param location string = resourceGroup().location
@description('Existing Container Apps environment (created for the portal worker).')
param environmentName string = 'cae-avddeploy'
@description('Existing Static Web App to link the API to; must be on the Standard plan.')
param staticWebAppName string = 'swa-avddeploy-portal'
@description('Object ID of the person who deploys (uploads the API bundle).')
param operatorObjectId string
@description('Clerk publishable key (public). The API derives the issuer and signing keys from it.')
param clerkPublishableKey string
@description('Portal origins whose Clerk tokens the API accepts.')
param authorizedParties array
@description('Clerk user IDs that may approve organisations.')
param akcAdminUserIds array
@description('Deploy the Container App and link it. False on the first pass, before the bundle has been uploaded.')
param deployApp bool = true
param bundleName string = ''
param bundleSha256 string = ''
@description('Azure Linux Node.js 24 image, pinned by digest.')
param image string = 'mcr.microsoft.com/azurelinux/base/nodejs:24.21.0-1-azl3.0.20260923-amd64@sha256:fd682d368b54a4df8cfb9181b9f4f25d78e10713416034fdce4ad1598036c206'
param tags object = { purpose: 'avd-deploy-hosted' }

var suffix = uniqueString(resourceGroup().id, 'control-plane')
var tableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-avddeploy-api'
  location: location
  tags: tags
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stavdcp${take(suffix, 13)}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
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
}

resource releases 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'releases'
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [for table in ['organisations', 'memberroles']: {
  parent: tableService
  name: table
}]

resource apiTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, tableDataContributor)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource apiBundleRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releases.id, identity.id, blobDataReader)
  scope: releases
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
  }
}

resource operatorBundleWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releases.id, operatorObjectId, blobDataContributor)
  scope: releases
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

// Gets a storage token from the Container Apps identity endpoint, downloads the bundle, checks its SHA-256 and runs it.
var bootstrap = '''
const { IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID, BUNDLE_URL, BUNDLE_SHA256 } = process.env;
const tokenUrl = `${IDENTITY_ENDPOINT}?api-version=2019-08-01&resource=${encodeURIComponent('https://storage.azure.com/')}&client_id=${AZURE_CLIENT_ID}`;
const token = (await (await fetch(tokenUrl, { headers: { 'X-IDENTITY-HEADER': IDENTITY_HEADER } })).json()).access_token;
const response = await fetch(BUNDLE_URL, { headers: { Authorization: `Bearer ${token}`, 'x-ms-version': '2023-11-03' } });
if (!response.ok) throw new Error(`Downloading the API bundle returned HTTP ${response.status}.`);
const bundle = Buffer.from(await response.arrayBuffer());
const { createHash } = await import('node:crypto');
if (createHash('sha256').update(bundle).digest('hex') !== BUNDLE_SHA256) throw new Error('The API bundle failed its SHA-256 check.');
(await import('node:fs')).writeFileSync('/tmp/server.mjs', bundle);
await import('/tmp/server.mjs');
'''

resource api 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: 'ca-avddeploy-api'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          command: ['node', '--input-type=module', '-e', bootstrap]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'PORT', value: '8080' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'STORAGE_ACCOUNT_NAME', value: storage.name }
            { name: 'CLERK_PUBLISHABLE_KEY', value: clerkPublishableKey }
            { name: 'AUTHORIZED_PARTIES', value: join(authorizedParties, ',') }
            { name: 'AKC_ADMIN_USER_IDS', value: join(akcAdminUserIds, ',') }
            { name: 'BUNDLE_URL', value: '${storage.properties.primaryEndpoints.blob}releases/${bundleName}' }
            { name: 'BUNDLE_SHA256', value: bundleSha256 }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/api/health', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/api/health', port: 8080 }, initialDelaySeconds: 3, periodSeconds: 10 }
          ]
        }
      ]
      // Scales to zero when idle; the first request after a quiet spell waits a few seconds.
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
  dependsOn: [apiTables, apiBundleRead]
}

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' existing = {
  name: staticWebAppName
}

// Same-origin /api: the Static Web App forwards /api/* to the Container App (Standard plan only).
resource link 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = if (deployApp) {
  parent: staticWebApp
  name: 'api'
  properties: {
    backendResourceId: api.id
    region: location
  }
}

output storageAccountName string = storage.name
output apiFqdn string = deployApp ? api!.properties.configuration.ingress.fqdn : ''
