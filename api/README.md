# AVD Deploy API

The hosted service's API ([ADR 0017](../docs/adr/0017-hosted-multi-tenant-service.md)–[0019](../docs/adr/0019-cross-tenant-execution.md)). Node 24 runs the TypeScript directly; there's no build step.

So far it covers **Get started** ([design](../docs/hosted-service.md#first-run-and-invitations)): who the signed-in user is, requesting AVD for an organisation, and AKC approval.

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /api/health` | anyone | Liveness |
| `GET /api/me` | signed in | User, active organisation, its AVD status and the user's AVD roles |
| `POST /api/organisations/request` | the active organisation's Clerk admin | Records a pending AVD request (idempotent) |
| `GET /api/admin/organisations?status=pending` | AKC admins | Lists requests |
| `POST /api/admin/organisations/{orgId}/approve` or `/decline` | AKC admins | Decides a pending request; approval makes the requester the first AVD Admin |

Every call except health needs a Clerk session token whose issuer, signature and `azp` (portal origin) check out. Tokens issued for other andykemp.com apps are rejected.

## Settings

| Variable | Example | Notes |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | `pk_live_…` | Public. The issuer and signing keys come from it. |
| `AUTHORIZED_PARTIES` | `https://avd-deploy.andykemp.com` | Comma-separated portal origins. |
| `AKC_ADMIN_USER_IDS` | `user_…` | Clerk user IDs that may approve organisations. |
| `STORAGE_ACCOUNT_NAME` | `stavddeploy…` | Table Storage via managed identity. Omit locally to keep data in memory. |
| `STORAGE_CONNECTION_STRING` | Azurite | Optional, local only. |
| `PORT` | `7071` | |

No secrets are needed for these endpoints.

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
