# ADR 0017: Portal MVP with Entra sign-in and browser-direct discovery

Status: Accepted. Date: 2026-10-15. Narrows [ADR 0002](0002-entra-sign-in.md) for the MVP; the API and on-behalf-of (OBO) flow remain the target.

## Context

The local wizard ([ADR 0014](0014-local-web-wizard.md)) needs PowerShell running on the operator's machine. The hosted portal (ADRs 0002, 0004, 0005) needs a bootstrap script, two app registrations, a linked API, workers and approval storage before anyone can sign in. The next useful step is smaller: sign in with Entra in a browser and see the subscriptions you can reach. Discovery runs as the signed-in operator in every design (ADR 0005), so it doesn't need a server-side identity.

A third-party identity provider such as Clerk was considered as a quicker start. It only establishes who someone is. Discovery still needs an Azure Resource Manager (ARM) access token issued by Entra, so a third-party provider would sit in front of Entra and handle Azure tokens for a privileged tool. ADR 0002 already rejects it.

## Decision

The portal MVP is a single-page app in [portal/](../../portal/) (React, Vite and MSAL.js):

- **One customer-owned, single-tenant SPA app registration** (`AzureADMyOrg`) using authorisation code with PKCE. No client secret or certificate exists. The tenant authority is explicit (`https://login.microsoftonline.com/<tenant-id>`), never `common` or `organizations`.
- **Delegated permissions only:** Microsoft Graph `User.Read` and Azure Service Management `user_impersonation`. Graph `GroupMember.Read.All` is added when the group picker moves to the portal.
- **Discovery calls ARM directly from the browser** with the operator's own token (`GET /subscriptions`, then locations, networks, SKUs and quota). ARM supports cross-origin calls, and the operator sees only what their Azure RBAC already allows, just as in the Azure portal.
- MSAL v5's redirect bridge ([portal/redirect.html](../../portal/redirect.html)) is the registered redirect URI. It is served from the app's own origin, never from a CDN.
- Tokens use MSAL's default `sessionStorage` cache, not `localStorage`.
- **Preview and Deploy stay in PowerShell** (`avd.ps1`). The portal will produce the same contract `1.6.0` configuration file, and the operator runs Preview and Deploy from the CLI.

## Path to deploying from the portal

The portal grows into the full deployment flow without rewriting the PowerShell engine in TypeScript. A browser-only design was rejected: stage sequencing would depend on an open tab, post-deploy would need highly privileged Graph scopes in the SPA, and the FSLogix share-permission step can't run from a browser.

1. **Form:** discovery (regions, networks, VM sizes, quota, groups) and sizing move into the SPA and produce the same contract `1.6.0` configuration. Until step 3 exists, the operator downloads it and runs the CLI.
2. **Hosting:** the SPA moves to SWA with a Content-Security-Policy in `staticwebapp.config.json`, and its URL is added to the app registration.
3. **Deploy worker ([ADR 0004](0004-hosting-and-workers.md)):** `avd.ps1`, `lib/` and `infra/` run unchanged in a pinned container as a Container Apps Job. A minimal API accepts an approved job (the operator types the resource group name) and puts its ID on a Storage queue. Stage progress goes to Table storage and the portal polls it.
4. **Preview through the worker**, so the portal shows the plan before approval.

Who runs what ([ADR 0005](0005-execution-identities.md), [permission matrix](../permission-matrix.md)):

| Step | Identity | Why |
| --- | --- | --- |
| Discovery, Preview | Signed-in operator (delegated) | Shows only what the operator can see; Preview fails if the operator couldn't deploy. |
| Foundation (first deployment to a subscription) | Signed-in operator | Creates the resource group, network, Key Vault and deployment identity, and grants that identity rights on the resource group. The worker never widens its own access. |
| Deploy (platform, session hosts, restarts) | AVD user-assigned managed identity | Outlives the operator's session; no stored human tokens. Rights only on the approved AVD resource groups, never subscription Owner, and no Graph permissions. |
| Post-deploy (RDP Entra setting, storage app consent, Conditional Access, FSLogix ACLs, dedicated-user group membership) | Signed-in operator | Tenant-wide Graph changes stay delegated and admin-role bound instead of becoming permanent application grants. |

The portal's own resources (SWA, job environment, registry, Storage, Key Vault) live in a separate resource group from AVD workloads. When anyone other than the installer can sign in, approval also requires a group-assigned app role ([ADR 0003](0003-group-assigned-app-roles.md)).

## Consequences

- Operators get a hosted-style sign-in with their tenant's MFA and Conditional Access, without a backend.
- ARM tokens exist in the browser. They are delegated, short-lived and scoped to the operator's own rights, but cross-site scripting (XSS) in the SPA could use them. The page keeps the wizard's rules: no `innerHTML` with data, pinned dependencies, and a restrictive Content-Security-Policy when hosted (`connect-src` limited to `login.microsoftonline.com`, `management.azure.com` and `graph.microsoft.com`).
- This deviates from ADR 0002's API-mediated discovery. When Preview moves server-side (Phase 3), the API registration and OBO flow are added and discovery can move behind the API. The SPA registration stays.
- Hosting follows ADR 0004 (SWA Standard) when the portal is installed. Until then it runs on `http://localhost:5173`.

## Alternatives rejected

- **Clerk or another third-party identity provider:** doesn't issue ARM tokens and conflicts with ADR 0002's identity boundary.
- **Building the API and OBO first:** delays any sign-in until bootstrap and hosting are built, and adds a confidential-client certificate before anything needs it.
- **Extending the local `HttpListener` wizard with MSAL:** keeps the portal tied to a local PowerShell process.
