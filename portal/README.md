# AVD Deploy portal (MVP)

A single-page app where you sign in with your Entra account and see the Azure subscriptions you can reach. See [ADR 0017](../docs/adr/0017-portal-mvp-browser-discovery.md) for the design. Preview and Deploy stay in [avd.ps1](../avd.ps1) for now.

## 1. Create the app registration (once per tenant)

Run this in PowerShell, signed in to the Azure CLI (`az login`) as someone allowed to create app registrations:

```powershell
$app = az ad app create --display-name 'AVD Deploy portal' --sign-in-audience AzureADMyOrg | ConvertFrom-Json

# SPA platform with the MSAL redirect bridge as the redirect URI. Add the SWA URL here when the portal is hosted.
$spa = @{ spa = @{ redirectUris = @('http://localhost:5173/redirect.html') } } | ConvertTo-Json -Depth 3 -Compress
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$($app.id)" `
  --headers 'Content-Type=application/json' --body ($spa -replace '"', '\"')

# Delegated permissions: Microsoft Graph User.Read and Azure Service Management user_impersonation.
az ad app permission add --id $app.appId --api 00000003-0000-0000-c000-000000000000 --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope
az ad app permission add --id $app.appId --api 797f4846-ba00-4fd7-ba43-dac1f8f63013 --api-permissions 41094075-9dad-4925-ad6f-9ab0ce2e8a0b=Scope
az ad sp create --id $app.appId | Out-Null

"VITE_AVD_TENANT_ID=$(az account show --query tenantId -o tsv)"
"VITE_AVD_CLIENT_ID=$($app.appId)"
```

Neither permission needs admin consent. If your tenant blocks user consent, a Global Administrator or Privileged Role Administrator can grant it once: `az ad app permission admin-consent --id <client-id>`.

## 2. Configure and run

```powershell
cd portal
Copy-Item .env.example .env.local   # paste the two values printed above
npm ci
npm run dev
```

Open `http://localhost:5173` and select **Sign in with Microsoft**. The subscription list comes straight from Azure Resource Manager (ARM) using your own token, so it shows exactly what your Azure RBAC allows.

`npm run build` type-checks and writes the static site to `dist/`.

## Notes

- The redirect URI must match the registration exactly, including the port and `/redirect.html`. Vite is pinned to port 5173 (`strictPort`) for that reason.
- Dependencies are pinned to exact versions. Update them deliberately and commit `package-lock.json`.
- Tokens are cached in `sessionStorage`, so closing the tab signs you out of the app (not of Entra).
