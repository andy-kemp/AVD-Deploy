# AVD Deploy API

The hosted service's API ([ADR 0017](../docs/adr/0017-hosted-multi-tenant-service.md)–[0019](../docs/adr/0019-cross-tenant-execution.md)). Node 24 runs the TypeScript directly; there's no build step.

So far it covers **Get started** ([design](../docs/hosted-service.md#first-run-and-invitations)): who the signed-in user is, requesting AVD for an organisation and AKC approval; and **Connect tenant** (ADR 0018): admin consent to the multi-tenant "AKC AVD Deploy" app, proved by a signed sign-in from an administrator of the same tenant.

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /api/health` | anyone | Liveness |
| `GET /api/me` | signed in | User, active organisation, its AVD status and the user's AVD roles |
| `POST /api/organisations/request` | the active organisation's Clerk admin | Records a pending AVD request (idempotent) |
| `GET /api/admin/organisations?status=pending` | AKC admins | Lists requests |
| `POST /api/admin/organisations/{orgId}/approve` or `/decline` | AKC admins | Decides a pending request; approval makes the requester the first AVD Admin |
| `POST /api/tenants/connect/start` | AVD Admin | Returns Microsoft's admin consent URL with a single-use, 15-minute state |
| `POST /api/tenants/connect/consented` | AVD Admin, same person | Takes the consent redirect and returns the proof sign-in URL (PKCE, nonce) for that tenant |
| `POST /api/tenants/connect/verify` | AVD Admin, same person | Redeems the sign-in with the managed identity as client credential, checks the tenant, a consent-capable admin role and the app's presence, and records the tenant (one organisation per tenant) |

Every call except health needs a Clerk session token whose issuer, signature and `azp` (portal origin) check out. Tokens issued for other andykemp.com apps are rejected.

## Settings

| Variable | Example | Notes |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | `pk_live_…` | Public. The issuer and signing keys come from it. |
| `AUTHORIZED_PARTIES` | `https://avd-deploy.andykemp.com` | Comma-separated portal origins. |
| `AKC_ADMIN_USER_IDS` | `user_…` | Clerk user IDs that may approve organisations. |
| `STORAGE_ACCOUNT_NAME` | `stavddeploy…` | Table Storage via managed identity. Omit locally to keep data in memory. |
| `STORAGE_CONNECTION_STRING` | Azurite | Optional, local only. |
| `ENTRA_CLIENT_ID` | GUID | The "AKC AVD Deploy" app from `scripts/create-entra-app.ps1`. Empty turns Connect tenant off. |
| `PORTAL_ORIGIN` | `https://avd-deploy.andykemp.com` | Base of the Microsoft redirect URIs; defaults to the first authorised party. |
| `AZURE_CLIENT_ID` | GUID | The API's managed identity, used as the app's federated credential. |
| `PORT` | `7071` | |

No secrets are needed: Connect tenant authenticates as the app with the API's managed identity (federated credential), so it only works when hosted.

## Run locally

Clerk production keys only work on andykemp.com domains, so use the Clerk **development** instance key locally (Clerk Dashboard → switch to Development → API keys), and enable Organizations there too ("Membership optional").

```powershell
cd api
npm ci
@"
CLERK_PUBLISHABLE_KEY=pk_test_...
AUTHORIZED_PARTIES=http://localhost:3000
AKC_ADMIN_USER_IDS=user_...   # your user ID in the development instance
"@ | Set-Content .env.local
npm run dev        # http://localhost:7071

cd ../portal/app
npm ci
"VITE_CLERK_PUBLISHABLE_KEY=pk_test_..." | Set-Content .env.local
npm run dev        # http://localhost:3000, /api is proxied to 7071
```

`npm test` runs the API tests (tokens signed with a throwaway key, including the negative cases); `npm run check` type-checks.
