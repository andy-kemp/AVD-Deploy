# AVD Deploy portal

A single-page app where you sign in with your Entra account and deploy Azure Virtual Desktop: subscription, region, network, groups, sizing with a VM size and quota check, profiles, scaling and display names. With the portal worker installed, it then runs Preview, lets you prepare the foundation with your own rights, and deploys after you approve. See [ADR 0017](../docs/adr/0017-portal-mvp-browser-discovery.md) for the portal and [ADR 0018](../docs/adr/0018-portal-worker.md) for the worker. Without the worker, it downloads an answers file for `avd.ps1`.

## Quick start: deploy everything with one script

As an Owner of the subscription who can also manage app registrations (signed in with `Connect-AzAccount`), with Node.js installed:

```powershell
.\scripts\deploy-portal.ps1 -SubscriptionId <subscription-id> -GrantAdminConsent
```

It deploys the Static Web App, creates or updates the app registration (redirect URIs, permissions and, with `-GrantAdminConsent`, tenant-wide consent), installs the worker, then builds and publishes the portal. It's safe to rerun after code changes; the URL stays the same. Use `-SkipWorker` for a download-only portal. The sections below describe the same steps by hand.

## 1. Create the app registration (once per tenant)

Run this in PowerShell, signed in to the Azure CLI (`az login`) as someone allowed to create app registrations:

```powershell
$app = az ad app create --display-name 'AVD Deploy portal' --sign-in-audience AzureADMyOrg | ConvertFrom-Json

# SPA platform with the MSAL redirect bridge as the redirect URI. Add the SWA URL here when the portal is hosted.
$spa = @{ spa = @{ redirectUris = @('http://localhost:5173/redirect.html') } } | ConvertTo-Json -Depth 3 -Compress
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" `
  --headers 'Content-Type=application/json' --body ($spa -replace '"', '\"')

# Delegated permissions: Graph User.Read, GroupMember.Read.All and Group.ReadWrite.All; Azure Service Management and
# Azure Storage user_impersonation.
$graphScope = { param($name) az ad sp show --id 00000003-0000-0000-c000-000000000000 --query "oauth2PermissionScopes[?value=='$name'].id" -o tsv }
az ad app permission add --id $app.appId --api 00000003-0000-0000-c000-000000000000 --api-permissions `
  e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope "$(& $graphScope GroupMember.Read.All)=Scope" "$(& $graphScope Group.ReadWrite.All)=Scope"
az ad app permission add --id $app.appId --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 --api-permissions 41094075-9dad-4925-ad6f-9ab0ce2e8a0b=Scope
$storageScope = az ad sp show --id e406a681-f3d4-42a8-90b6-c2b029497af1 --query "oauth2PermissionScopes[?value=='user_impersonation'].id" -o tsv
az ad app permission add --id $app.appId --api e406a681-f3d4-42a8-90b6-c2b029497af1 --api-permissions "$storageScope=Scope"
az ad sp create --id $app.appId | Out-Null

"VITE_AVD_TENANT_ID=$(az account show --query tenantId -o tsv)"
"VITE_AVD_CLIENT_ID=$($app.appId)"
```

`GroupMember.Read.All` (group search) and `Group.ReadWrite.All` (creating the AVD groups before a run) need admin consent. Grant it once as a Global Administrator or Privileged Role Administrator: `az ad app permission admin-consent --id <client-id>`. The other permissions don't.

## 2. Install the portal worker (optional, ADR 0018)

The worker runs Preview and Deploy in a Container Apps Job. As an Owner of the subscription, with the Bicep CLI on PATH:

```powershell
.\scripts\install-portal-worker.ps1 -SubscriptionId <subscription-id> -PortalOrigins 'https://<hostname>', 'http://localhost:5173'
```

It prints `VITE_AVD_WORKER_STORAGE` and `VITE_AVD_WORKER_JOB` for `.env.local`. Rerun it after changing `avd.ps1`, `lib/`, `infra/` or `contracts/`, so the job uses the new code.

## 3. Configure and run

```powershell
cd portal
Copy-Item .env.example .env.local   # paste the values printed above
npm ci
npm run dev
```

Open `http://localhost:5173` and select **Sign in with Microsoft**. Discovery calls Azure Resource Manager (ARM) and Microsoft Graph with your own token, so it shows exactly what your rights allow.

## 4. Deploy

**With the worker:** fill in the form and select **Run Preview in Azure**. The run page shows progress and the log. If the resource group is new, select **Prepare (as me)**: the portal creates the resource group, network, Key Vault and admin password with your rights, and gives the worker access to that resource group only. Preview then runs again. Review the plan, type the resource group name and select **Deploy**. Afterwards, download the configuration and run `.\avd.ps1 -Mode PostDeploy -ConfigurationFile <file>` for the tenant-wide Entra settings.

**Without the worker:** select **Download answers**, move the file into your AVD-Deploy folder and run the commands the page shows:

```powershell
.\avd.ps1 -Mode New -AnswersFile .\avd-answers-avd.json -OutputFile .\sandbox\avd.json
.\avd.ps1 -Mode Preview -ConfigurationFile .\sandbox\avd.json
.\avd.ps1 -Mode Deploy -ConfigurationFile .\sandbox\avd.json -AsSignedInUser -PostDeploy
```

`-Mode New -AnswersFile` checks the file against [contracts/avd-answers.schema.json](../contracts/avd-answers.schema.json), then creates any new groups, picks Key Vault and storage names and writes the configuration as you. Add `-Force` to overwrite an existing configuration.

`npm run build` type-checks and writes the static site to `dist/`.

## Hosting on Azure Static Web Apps

The test instance runs on the Free tier: `swa-avddeploy-portal` in `rg-avddeploy-portal`. Free is enough for a static page. The build writes `dist/staticwebapp.config.json` from [staticwebapp.config.template.json](staticwebapp.config.template.json): a Content-Security-Policy that allows connections only to Entra, ARM, Graph and the worker's storage account, `redirect.html` uncached, and deep links routed to the app.

1. Add `https://<hostname>/redirect.html` to the app registration's SPA redirect URIs.
2. Build with the values in `.env.local` (Vite embeds them at build time; they aren't secrets).
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
