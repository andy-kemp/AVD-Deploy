# ADR 0018: Clerk accounts and a separate Microsoft tenant connection

Status: Proposed. Date: 2026-10-16. Supersedes [ADR 0002](0002-entra-sign-in.md) and [ADR 0003](0003-group-assigned-app-roles.md) for the hosted service.

## Context

A hosted service needs its own accounts: sign-up, organisations, invitations, roles and later billing. Separately, the engine needs Microsoft tokens for two different APIs in the customer tenant: Azure Resource Manager (`https://management.azure.com`) and Microsoft Graph. Entra issues one access token per API, so a single stored "Microsoft login" token is not enough.

Clerk's backend `getUserOauthAccessToken` returns the stored token for a user and provider; it takes no parameter for which API the token is for. Clerk is a good fit for portal accounts but not as the holder of ARM and Graph tokens.

## Decision

Use two layers.

### 1. Portal accounts: Clerk

- Clerk handles sign-up, sign-in, MFA and sessions. "Sign in with Microsoft" is allowed as a Clerk login method, but it only proves who the person is.
- A **Clerk organisation** is a customer. Organisation roles replace the `Portal.*` app roles of ADR 0003:

  | AVD role | Clerk permissions | Can |
  | --- | --- | --- |
  | Reader | `org:avd:read` | View estates, plans and job history |
  | Operator | `org:avd:read`, `org:avd:operate` | Run discovery, create configurations and previews, submit plans |
  | Approver | `org:avd:read`, `org:avd:approve` | Approve plans (not their own, where the organisation requires independent approval) |
  | Admin | all four, including `org:avd:admin` | Enable AVD for the organisation, connect or disconnect tenants, manage approval policy |

- The API verifies the Clerk session token (signature, issuer, expiry, organisation and role) on every request. Clerk roles grant portal actions only; they never grant Azure or Graph rights.

### Reusing the existing andykemp.com Clerk instance

AKC already runs other apps on andykemp.com with one Clerk production instance. The AVD portal joins that instance rather than creating a new one, so people already signed in to another andykemp.com app are signed in here too. Because the instance is shared:

- **Pin the token to this app.** The API passes `authorizedParties: ['https://avd-deploy.andykemp.com']` to Clerk's `verifyToken` (it checks the token's `azp`). A session token minted for another andykemp.com app is rejected by the AVD API.
- **Use AVD-specific permissions, not shared role names.** Organisation roles and permissions are instance-wide, so a generic `org:admin` from another app must not mean anything here. Define custom permissions `org:avd:read`, `org:avd:operate`, `org:avd:approve` and `org:avd:admin`, attach them to roles, and have the API check permissions only. The role table above describes which permissions each AVD role carries.
- **Opt in per organisation.** A Clerk organisation created for another app is not an AVD customer until an organisation admin enables AVD (an AVD organisation record in the control-plane store). Membership alone grants nothing.
- **Keep AVD data out of Clerk metadata.** Tenant IDs, connections and token references live only in the AVD control-plane store, never in Clerk user or organisation metadata that other apps on the instance can read.
- **Shared sign-in policy.** MFA, social connections and session lifetime are instance settings shared with the other apps. Require MFA for any member holding `org:avd:approve` or `org:avd:admin`; if the instance can't enforce that per permission, re-check a recent second factor (Clerk step-up/reverification) before approval and tenant connection.

### 2. Tenant connection: AKC's multi-tenant Entra app

- The API is a confidential client of the multi-tenant "AKC AVD Deploy" app and runs the Microsoft authorisation code flow itself (MSAL), not through Clerk.
- **Connect tenant** (organisation admin): sends a customer administrator to the v2.0 admin consent endpoint for the customer's tenant. On success the API records the Entra tenant ID (`tid`) against the Clerk organisation. A tenant can belong to only one organisation; a second claim needs AKC review.
- **Link Microsoft account** (each operator): every operator signs in once with their own work account in that tenant. The API stores the link (Clerk user ID, `tid`, Entra object ID `oid`) and an encrypted MSAL token cache. Operators never share an administrator's connection, so every delegated action is attributable to a real person and limited by their own Entra and Azure roles.
- On every request the API checks that the Clerk organisation owns the tenant, and that the Clerk user's linked `tid` matches it. A mismatch fails closed.
- Delegated permissions requested (admin-consented once): Azure Resource Manager `user_impersonation`; Graph `User.ReadBasic.All`, `GroupMember.Read.All`, `Application.Read.All` for discovery; and, for the post-deploy steps, the scopes already listed in the [permission matrix](../permission-matrix.md) (`Application-RemoteDesktopConfig.ReadWrite.All`, `DelegatedPermissionGrant.ReadWrite.All`, `Application.ReadWrite.All`, `Policy.Read.All`, `Policy.ReadWrite.ConditionalAccess`, `Group.Read.All`, `Device.Read.All`, `GroupMember.ReadWrite.All`), plus `offline_access`. Consent for delegated scopes never widens what a user can do: the operator still needs the matching Entra role.
- No Graph **application** permissions are requested for AVD. Windows 365 (ADR 0006) will add its own consent step later.

## Consequences

- Customers see one enterprise application with a verified publisher (AKC must complete Microsoft publisher verification, with andykemp.com as the publisher domain). Its redirect URIs are on `avd-deploy.andykemp.com` only.
- A security problem in another andykemp.com app sharing the Clerk instance can expose that app's sessions, but not the AVD API's, as long as the `azp` and permission checks hold. Those checks are release gates.
- Refresh tokens are sensitive. They are encrypted with a key in AKC's Key Vault, scoped per user and tenant, and deleted when the user unlinks, leaves the organisation or the tenant is disconnected.
- If a customer's Conditional Access blocks the app or requires a compliant device, delegated steps fail and are shown as a "reconnect" or manual task, never retried with another identity.
- A customer can revoke everything by deleting the enterprise application in their tenant.

## Alternatives considered

- **Clerk as the Microsoft token holder.** One stored token per provider cannot serve both ARM and Graph, and ties tenant access to whichever account was used to log in.
- **Entra-only sign-in (multi-tenant).** Workable, but loses Clerk's organisations, invitations and billing, and forces every customer user to have an Entra account just to view a report.
- **Entra External ID for portal accounts.** A valid future option if the product stays Microsoft-only; Clerk was chosen for speed and the billing roadmap.
