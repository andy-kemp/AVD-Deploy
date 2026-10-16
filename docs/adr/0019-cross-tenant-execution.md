# ADR 0019: Cross-tenant execution

Status: Proposed. Date: 2026-10-16. Supersedes [ADR 0005](0005-execution-identities.md) for the hosted service; its principles (no fallback, no self-grants, least privilege) carry over.

## Context

A deployment takes 30-90 minutes and must survive the user closing the browser. Discovery and preview must reflect what the signed-in operator can see. Some steps (subscription-scope setup, Graph changes) are too privileged to give a standing vendor identity.

## Decision

Split the work by who runs it.

| Stage | Runs as | Why |
| --- | --- | --- |
| Discovery, sizing, Preview (what-if) | The operator, delegated | Shows only what that person can see and deploy |
| **Onboard subscription**: register providers, create the workload resource group, grant the AKC app its roles, assign the AVD power role at subscription scope | The operator, delegated, after explicit confirmation | Needs subscription Owner-level rights; these are never given to AKC |
| Foundation (VNet, NAT, Key Vault, password) | AKC app, inside the onboarded resource group | Resource-group scoped; the subscription-scope parts already ran at onboarding |
| Deploy: platform, token, session hosts, registration check, restart, host assignment | **AKC app service principal** in the customer tenant | Long-running; must not depend on a browser session |
| Post-deploy Entra and storage steps (RDP Entra authentication, storage app consent and URIs, Conditional Access exclusion, folder ACLs, device check) | The operator, delegated, as its own job | Tenant-wide or security-control changes stay with an accountable person |
| Dedicated user group membership | The operator, delegated | As ADR 0012 |

### AKC app credential: no secrets

The worker runs in Azure Container Apps Jobs with a user-assigned managed identity in AKC's tenant. That managed identity is configured as a federated identity credential on the multi-tenant app. At runtime the worker exchanges its managed identity token for an app token issued by the customer's tenant. There is no client secret or certificate to leak or rotate.

### What the customer grants the AKC app (at onboarding)

At the **workload resource group** only:

- **Contributor**, for the AVD, compute, network, storage and Key Vault resources the Bicep creates.
- **Role Based Access Control Administrator, with a condition** that allows assigning and removing only these roles, only to `Group` and `ServicePrincipal` principals:
  - Desktop Virtualization User (`1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63`)
  - Virtual Machine User Login (`fb879df8-f326-4884-b1cf-06f3ad86be52`)
  - Virtual Machine Administrator Login (`1c0163c0-47e6-4577-8991-ea5c82e286e4`)
  - Desktop Virtualization Power On Contributor (`489581de-a3bd-480d-9518-53dea7416b33`)
  - Storage File Data SMB Share Contributor (`0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb`)
  - Storage File Data SMB Share Elevated Contributor (`a7264617-510b-434b-a828-9731dc254ea7`)
  - Key Vault Secrets User (`4633458b-17de-408a-b874-0445c86b69e6`)

  This is the set the current Bicep assigns. Any change to the Bicep's role assignments must update this list and the onboarding step together.
In hosted mode the foundation stage grants Key Vault Secrets User on the new vault to the AKC app's service principal, instead of to the operator and a customer managed identity, so the worker can read the admin password it passes to the session-host template. The foundation's `deploymentIdentity` is not created in hosted mode.

Nothing at subscription scope, and no Graph application permissions.

### Rules carried over from ADR 0005

- A delegated failure is reported, never retried as the AKC app.
- The AKC app cannot change its own grants (the condition excludes Contributor, Owner, User Access Administrator and RBAC Administrator).
- Each job is bound to an approved plan for one organisation, tenant, subscription and resource group; the worker re-checks all four before calling Azure.

### Delegated jobs

Delegated stages queued as jobs (post-deploy) use the operator's encrypted MSAL token cache. They run only within a short window after the operator triggers them (default 2 hours). If the token is expired or revoked, the stage stops with a "reconnect and retry" task.

## Consequences

- A customer with only resource-group rights can still use the service if their subscription owner runs **Onboard subscription** once.
- Revocation is simple for the customer: remove the two role assignments, or delete the enterprise application.
- The worker's managed identity in AKC's tenant can reach every onboarded resource group. It becomes AKC's most sensitive identity: no human access, alerting on unexpected use, and job containers that run only the pinned image.
- Exact Azure action minima and the condition expression must be proven in a sandbox before launch (existing verification gap).

## Alternatives considered

- **Everything delegated.** No standing vendor access at all, but deployments depend on refresh tokens and the user's Conditional Access session for the whole run. Viable for a first private pilot; kept as a fallback mode.
- **Customer-owned managed identity with a federated credential trusting AKC.** Puts the identity in the customer's tenant, but needs a cross-tenant issuer trust that is harder for customers to understand and audit than an enterprise application.
- **App Contributor or Owner at subscription scope.** Simpler, but far broader than AVD needs.
