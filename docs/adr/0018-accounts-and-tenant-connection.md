# ADR 0018: Clerk accounts and a separate Microsoft tenant connection

Status: Proposed. Date: 2026-10-16. Supersedes [ADR 0002](0002-entra-sign-in.md) and [ADR 0003](0003-group-assigned-app-roles.md) for the hosted service.

## Context

A hosted service needs its own accounts: sign-up, organisations, invitations, roles and later billing. Separately, the engine needs Microsoft tokens for two different APIs in the customer tenant: Azure Resource Manager (`https://management.azure.com`) and Microsoft Graph. Entra issues one access token per API, so a single stored "Microsoft login" token is not enough.

Clerk's backend `getUserOauthAccessToken` returns the stored token for a user and provider; it takes no parameter for which API the token is for. Clerk is a good fit for portal accounts but not as the holder of ARM and Graph tokens.

## Decision

Use two layers.

### 1. Portal accounts: Clerk

- Clerk handles sign-up, sign-in, sessions, organisations, invitations and membership. "Sign in with Microsoft" or Google is allowed as a Clerk login method, but it only proves who the person is.
- A **Clerk organisation** is a customer. **AVD roles are stored in the AVD control plane**, keyed by Clerk organisation ID and user ID, not as Clerk roles. They replace the `Portal.*` app roles of ADR 0003:

  | AVD role | Permissions | Can |
  | --- | --- | --- |
  | Reader | `read` | View estates, plans and job history |
  | Operator | `read`, `operate` | Run discovery, create configurations and previews, submit plans |
  | Approver | `read`, `approve` | Approve plans (not their own, where the organisation requires independent approval) |
  | Admin | all four, including `admin` | Connect or disconnect tenants, manage AVD roles and approval policy |

  A member can hold several AVD roles, alongside whatever Clerk role they have for other apps.
- The API verifies the Clerk session token (signature, issuer, expiry, `azp`, active organisation) on every request, then reads the caller's AVD roles for that organisation from the control plane. AVD roles grant portal actions only; they never grant Azure or Graph rights.
- **Why not Clerk custom roles:** they need a paid add-on in production, a Clerk member has exactly one role per organisation (so an organisation's admin for another app couldn't also be an AVD Approver), and roles are instance-wide, so AVD roles would appear in the other apps.

### Reusing the existing andykemp.com Clerk instance

AKC already runs other apps on andykemp.com with one Clerk production instance. The AVD portal joins that instance rather than creating a new one, so people already signed in to another andykemp.com app are signed in here too. Because the instance is shared:

- **Pin the token to this app.** The API passes `authorizedParties: ['https://avd-deploy.andykemp.com']` to Clerk's `verifyToken` (it checks the token's `azp`). A session token minted for another andykemp.com app is rejected by the AVD API.
- **Clerk roles mean nothing here, except once.** A Clerk organisation role such as `org:admin` may have been given for another app, so it grants no AVD permission. The only exception is the first AVD Admin, below.
- **Organisations are optional on the instance** ("Membership optional"), so users of the other apps are never forced into one. The AVD API refuses AVD actions without an active organisation.
- **Getting started and invitations happen in AVD Deploy only.** Its Get started screen creates or chooses an organisation and requests AVD; nothing is triggered from Clerk's `user.created` event, which fires for sign-ups to every andykemp.com app. AVD Admins invite colleagues through the portal: the API creates the Clerk organisation invitation and stores a pending AVD role, applied when Clerk's `organizationMembership.created` webhook arrives ([design](../hosted-service.md#first-run-and-invitations)).
- **Removing a member removes their AVD roles.** A Clerk webhook (`organizationMembership.deleted`, `organization.deleted`) deletes the matching AVD roles and account links, and every request also checks that the token's active organisation is the one the role belongs to.
- **Opt in per organisation.** A Clerk organisation created for another app is not an AVD customer until an organisation admin enables AVD (an AVD organisation record in the control-plane store). Membership alone grants nothing.
- **Private beta gate.** Anyone can sign in, but enabling AVD creates a *pending* organisation record that AKC must approve before the organisation can connect a tenant. The gate stays until publisher verification, terms of service, a data processing agreement and pricing are in place; removing it later is a setting, not a redesign.
- **The first AVD Admin.** **Enable AVD** is the only action that accepts Clerk's built-in organisation admin role (`rol: admin` in the session token; Clerk leaves system permissions out of tokens). When AKC approves the organisation, the API records that person as its first AVD Admin, and who approved it. After that, only AVD roles count, and AVD Admins manage the others.
- **Keep AVD data out of Clerk metadata.** Tenant IDs, connections and token references live only in the AVD control-plane store, never in Clerk user or organisation metadata that other apps on the instance can read.
- **MFA comes from the customer's Microsoft sign-in.** Social connections and session lifetime are instance settings shared with the other apps. Clerk MFA needs a paid plan in production, and Clerk can't see the MFA a person did at Microsoft or Google (its `fva` claim only records Clerk's own factors). Instead, approving a plan, connecting or disconnecting a tenant, and changing AVD roles require a fresh sign-in (at most 10 minutes old) to the operator's **linked work account**, whose Entra token must show MFA (`amr` contains `mfa`). That also applies the customer's own Conditional Access. A recent Clerk second factor (`fva[1]` of 10 minutes or less) is accepted instead, if AKC ever turns Clerk MFA on.

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
