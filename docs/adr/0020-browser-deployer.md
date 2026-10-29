# ADR 0020: Browser deployer at deploy.andykemp.com/avd

Status: **Accepted** (Andy, 2026-10-29). Date: 2026-10-29.

Decided in akc-tools [ADR 0004](https://github.com/andy-kemp/akc-tools/blob/main/docs/adr/0004-avd-in-the-browser.md). It supersedes the hosted design on the `design/hosted-service` branch (ADRs 0017 to 0019, never merged): AKC-hosted jobs running as a multi-tenant app, stored refresh tokens and subscription onboarding grants.

## Decision

- **Where it runs:** AVD Deploy's customer journey runs at `deploy.andykemp.com/avd` (akc-tools `apps/web/src/avd`), in the admin's browser.
  - It calls ARM and Microsoft Graph with the admin's delegated token.
  - AKC stores no token, password or registration token, and keeps no access to the customer's tenant.
- **What this repository keeps:** the engine. The templates, the session-host preparation script, the sizing profiles and contract, and the CLI (`avd.ps1`) all stay here, and the CLI works as before.
- **Releases:** `scripts/build-release.mjs` builds an immutable release into akc-tools (`apps/web/public/releases/avd/<version>/`), with a SHA-256 manifest the browser checks.

### Engine changes for the browser deployer

These are additive. The CLI ignores them.

- **`infra/avd/session-hosts-from-vault.bicep`** wraps `session-hosts.bicep` and reads the admin password through an ARM Key Vault reference, so the browser never handles it after the foundation stores it.
- **The foundation's Key Vault sets `enabledForTemplateDeployment`.** Only principals with `Microsoft.KeyVault/vaults/deploy/action` on that vault can use it.
- **`scripts/set-profile-acls.ps1`** sets the FSLogix share-root permissions as a Run Command on a session host. It uses the VM's managed identity, which has a temporary *Storage File Data Privileged Contributor* role, and goes through the private endpoint. The storage firewall is never opened. The SDDL is the same as `lib/AvdPostDeploy.psm1`.

## Consequences

- The hosted branch's API, portal, Container Apps infrastructure and the "AKC AVD Deploy" multi-tenant app are not needed. The branch can be closed once Andy agrees.
- **Keep the browser deployer's TypeScript in step with the PowerShell modules:**
  - sizing (`lib/AvdSizing.psm1`);
  - names and networks (`lib/AvdDiscovery.psm1`);
  - parameters and checks (`lib/AvdDeployment.psm1`);
  - Finish setup (`lib/AvdPostDeploy.psm1`).

  akc-tools has parity tests for the pure parts.
