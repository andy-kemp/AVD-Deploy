# AVD Deploy portal (MVP)

A single-page app where you sign in with your Entra account and plan an AVD deployment: subscription, region, network, groups, sizing with a VM size and quota check, profiles, scaling and display names. It downloads an answers file that `avd.ps1` turns into a configuration. See [ADR 0017](../docs/adr/0017-portal-mvp-browser-discovery.md) for the design. Preview and Deploy stay in [avd.ps1](../avd.ps1) for now.

## 1. Create the app registration (once per tenant)

Run this in PowerShell, signed in to the Azure CLI (`az login`) as someone allowed to create app registrations:

```powershell
$app = az ad app create --display-name 'AVD Deploy portal' --sign-in-audience AzureADMyOrg | ConvertFrom-Json

# SPA platform with the MSAL redirect bridge as the redirect URI. Add the SWA URL here when the portal is hosted.
$spa = @{ spa = @{ redirectUris = @('http://localhost:5173/redirect.html') } } | ConvertTo-Json -Depth 3 -Compress
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" `
  --headers 'Content-Type=application/json' --body ($spa -replace '"', '\"')

# Delegated permissions: Microsoft Graph User.Read and GroupMember.Read.All, and Azure Service Management user_impersonation.
$groupRead = (az ad sp show --id 00000003-0000-0000-c000-000000000000 --query "oauth2PermissionScopes[?value=='GroupMember.Read.All'].id" -o tsv)
az ad app permission add --id $app.appId --api 00000003-0000-0000-c000-000000000000 --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope "$groupRead=Scope"
az ad app permission add --id $app.appId --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 --api-permissions 41094075-9dad-4925-ad6f-9ab0ce2e8a0b=Scope
az ad sp create --id $app.appId | Out-Null

"VITE_AVD_TENANT_ID=$(az account show --query tenantId -o tsv)"
"VITE_AVD_CLIENT_ID=$($app.appId)"
```

`User.Read` and `user_impersonation` don't need admin consent. `GroupMember.Read.All` does; it's only used when you search for an existing group. Grant it once as a Global Administrator or Privileged Role Administrator: `az ad app permission admin-consent --id <client-id>`. Without it you can still create new groups from the form.

## 2. Configure and run

```powershell
cd portal
Copy-Item .env.example .env.local   # paste the two values printed above
npm ci
npm run dev
```

Open `http://localhost:5173` and select **Sign in with Microsoft**. Discovery calls Azure Resource Manager (ARM) and Microsoft Graph with your own token, so it shows exactly what your rights allow.

## 3. From answers to deployment

Fill in the form and select **Download answers**. Move the file into your AVD-Deploy folder and run the commands the page shows:

```powershell
.avd.ps1 -Mode New -AnswersFile .avd-answers-avd.json -OutputFile .sandboxavd.json
.avd.ps1 -Mode Preview -ConfigurationFile .sandboxavd.json
.avd.ps1 -Mode Deploy -ConfigurationFile .sandboxavd.json -AsSignedInUser -PostDeploy
```

`-Mode New -AnswersFile` checks the file against [contracts/avd-answers.schema.json](../contracts/avd-answers.schema.json), then creates any new groups, picks Key Vault and storage names and writes the configuration as you. Add `-Force` to overwrite an existing configuration.

`npm run build` type-checks and writes the static site to `dist/`.

## Hosting on Azure Static Web Apps

The test instance runs on the Free tier: `swa-avddeploy-portal` in `rg-avddeploy-portal`. Free is enough for a static page; ADR 0004's Standard tier is needed once the API is linked. [public/staticwebapp.config.json](public/staticwebapp.config.json) sets the Content-Security-Policy (connections only to Entra, ARM and Graph), serves `redirect.html` uncached and routes deep links to the app.

1. Add `https://<hostname>/redirect.html` to the app registration's SPA redirect URIs.
2. Build with the tenant and client IDs in `.env.local` (Vite embeds them at build time; they aren't secrets).
3. Publish with the site's deployment token in an environment variable, so it never appears on the command line:

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = '<from the portal: Static Web App > Manage deployment token>'
npm run build
npx --yes @azure/static-web-apps-cli@2.0.10 deploy ./dist --env production
Remove-Item Env:SWA_CLI_DEPLOYMENT_TOKEN
```

## Notes

- The redirect URI must match the registration exactly, including the port and `/redirect.html`. Vite is pinned to port 5173 (`strictPort`) for that reason.
- Dependencies are pinned to exact versions. Update them deliberately and commit `package-lock.json`.
- Tokens are cached in `sessionStorage`, so closing the tab signs you out of the app (not of Entra).
- Sizing reads [contracts/sizing-profiles.json](../contracts/sizing-profiles.json), shared with `avd.ps1`. The image list, VM size check and time-zone suggestions in [src/planning.ts](src/planning.ts) mirror the PowerShell helpers named in its comments; keep them in step when those change. Generation and Preview re-check everything.
