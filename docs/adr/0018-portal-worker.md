# ADR 0018: Portal worker for Preview and Deploy

Status: Accepted. Date: 2026-10-15. Implements step 3 of [ADR 0017](0017-portal-mvp-browser-discovery.md) for a single-operator installation; narrows the API part of [ADR 0004](0004-hosting-and-workers.md).

## Context

The portal collects answers ([ADR 0017](0017-portal-mvp-browser-discovery.md)) but Preview and Deploy still ran in a terminal. Deploy runs for 30–60 minutes, so it can't run in the browser or an HTTP request. [ADR 0005](0005-execution-identities.md) keeps changes that need high privileges (resource group creation, subscription-scope role grants, Entra groups, post-deploy) with the signed-in operator, and a managed identity must not widen its own access. `avd.ps1` already enforces this: as a managed identity, Preview reports a missing foundation as a blocker and Deploy refuses to create it.

## Decision

A **Container Apps Job** runs the unchanged `avd.ps1` as a user-assigned managed identity, `id-avddeploy-worker`. The portal drives it with the operator's own tokens; there is no API.

| Step | Runs as | What happens |
| --- | --- | --- |
| Subscription access | Operator, in the browser (ARM) | The install grants the worker Reader on its own subscription. For any other subscription, the form detects that the worker can't read it and offers to grant Reader there. |
| Groups | Operator, in the browser (Graph `Group.ReadWrite.All`) | New users/admins groups are created or reused before the run, so the worker never calls Graph. |
| Submit | Operator (Storage Blob Data Contributor, Azure RBAC on the job) | The browser saves the answers to `jobs/<run>/answers.json` and starts a job execution with the run ID and action. |
| Preview | Worker (Reader on the subscription) | `-Mode New -AnswersFile -PortalWorker`, then `-Mode Foundation`, then `-Mode Preview`. Writes the configuration, foundation request, plan, status and log to the run's folder. |
| Prepare | Operator, in the browser (ARM) | Registers missing providers and submits the foundation the worker compiled: resource group, network, Key Vault and generated admin password, autoscale role, and the worker's access to **that resource group only**. Then Preview runs again. |
| Deploy | Worker (rights granted by Prepare) | After the operator types the resource group name, `-Mode Deploy` runs the saved plan. |
| Post-deploy | Operator, in a terminal | Unchanged ([ADR 0015](0015-post-deploy-configuration.md)): tenant-wide Graph changes stay with the operator. |

The worker's per-deployment rights, granted by the operator's foundation ([foundation-worker-access.bicep](../../infra/avd/modules/foundation-worker-access.bicep)):

- Contributor on the AVD resource group.
- Role Based Access Control Administrator on the resource group, **conditioned** to the six roles the workload templates assign (Desktop Virtualization User, Virtual Machine User Login, Virtual Machine Administrator Login, Desktop Virtualization Power On Contributor, and Storage File Data SMB Share Contributor and Elevated Contributor for FSLogix). It cannot grant itself or anyone else any other role. Phase 1 tests fail if the templates assign a role outside this list. When the list changes, the foundation check treats an older condition as incomplete, so Prepare updates it.
- Key Vault Secrets User on the resource group, to read the admin password.
- Network Contributor on an existing VNet outside the resource group, when one is used.

Other rules:

- **Generation without Graph.** With `-PortalWorker`, `avd.ps1` uses the group IDs from the portal and the AVD service principal ID recorded at install. Like Preview as a managed identity, it doesn't verify the groups through Graph.
- **Role checks use ARM.** Role-assignment checks read `Microsoft.Authorization/roleAssignments` directly, because `Get-AzRoleAssignment` resolves principals through Graph, which the worker can't do.
- **The password never reaches the worker or storage.** The browser generates it (same rules as `New-AvdAdminPassword`) and sends it once to ARM as a secure parameter. The worker reads it from Key Vault.
- **Pinned code.** The job runs a code bundle from the `releases` container whose SHA-256 is fixed in the job definition, in the Azure PowerShell image pinned by digest. The worker downloads Bicep and checks it against a fixed hash. [scripts/install-portal-worker.ps1](../../scripts/install-portal-worker.ps1) builds and uploads the bundle and updates the job.
- **Storage** has no account keys or anonymous access, allows CORS only from the portal origins, and deletes run records after 90 days. The portal's CSP adds only that account's blob endpoint.

## Consequences

- The whole flow (form, Preview, Prepare, approve, Deploy with live log) runs in the portal, and Deploy continues if the browser closes.
- Authorisation is Azure RBAC: whoever can write the `jobs` container and start the job can run deployments, within the worker's rights. That suits one operator who already owns the subscription. Before others use the portal, add ADR 0004's API and group-assigned app roles ([ADR 0003](0003-group-assigned-app-roles.md)) so approval is checked server-side, and remove the operators' direct job-start rights.
- A start override replaces the job's container definition, so an operator with job-start rights could run other code as the worker. The worker's rights are bounded to Reader plus prepared resource groups, and today's only operator is the subscription Owner.
- The portal registration needs `Group.ReadWrite.All` (admin consent) and Azure Storage `user_impersonation`.
- Updating PowerShell or Bicep code needs a rerun of the install script so the job uses the new bundle; a plan made by an older bundle fails Deploy's template-hash check and must be previewed again.

## Alternatives rejected

- **Worker with Owner on the subscription:** fastest, but a compromised portal or bundle would control the subscription, and it would need `avd.ps1` to let a managed identity act as the operator.
- **Browser-only orchestration:** stage sequencing would depend on an open tab, and post-deploy would need privileged Graph scopes in the SPA.
- **Passing the operator's token to the job:** stores a human credential in a job definition and its history.
