// Hosts the portal SPA (ADR 0017). Free is enough for static content; ADR 0004's Standard tier is only needed for a
// linked API.
@description('Static Web Apps region (not offered in every region; content is served globally).')
param location string = 'westeurope'
param name string = 'swa-avddeploy-portal'
param tags object = { purpose: 'avd-deploy-portal' }

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

output hostname string = site.properties.defaultHostname
