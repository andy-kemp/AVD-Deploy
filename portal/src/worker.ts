// Portal worker client (ADR 0018). Everything here runs with the operator's own token: blob storage for job inputs and
// results, ARM to start the Container Apps Job, and ARM to deploy the foundation.
const armBase = 'https://management.azure.com';
const storageVersion = '2023-11-03';

export const workerStorage = (import.meta.env.VITE_AVD_WORKER_STORAGE as string | undefined) ?? '';
export const workerJob = (import.meta.env.VITE_AVD_WORKER_JOB as string | undefined) ?? '';
export const workerConfigured = /^[a-z0-9]{3,24}$/.test(workerStorage) && /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.App\/jobs\/[^/]+$/i.test(workerJob);

const blobUrl = (path: string) => `https://${workerStorage}.blob.core.windows.net/jobs/${path}`;

export async function putJobBlob(token: string, path: string, body: string, contentType = 'application/json'): Promise<void> {
  const response = await fetch(blobUrl(path), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': storageVersion, 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
    body,
  });
  if (response.status !== 201) throw new Error(`Saving ${path} failed with HTTP ${response.status}.`);
}

export async function getJobBlob(token: string, path: string): Promise<string | null> {
  const response = await fetch(blobUrl(path), { headers: { Authorization: `Bearer ${token}`, 'x-ms-version': storageVersion }, cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading ${path} failed with HTTP ${response.status}.`);
  return response.text();
}

export async function getJobJson<T>(token: string, path: string): Promise<T | null> {
  const text = await getJobBlob(token, path);
  return text === null ? null : (JSON.parse(text) as T);
}

export async function listJobIds(token: string): Promise<string[]> {
  const response = await fetch(`https://${workerStorage}.blob.core.windows.net/jobs?restype=container&comp=list&delimiter=/`, {
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': storageVersion },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Listing runs failed with HTTP ${response.status}.`);
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  return [...xml.querySelectorAll('BlobPrefix > Name')].map((n) => (n.textContent ?? '').replace(/\/$/, '')).filter((id) => /^[0-9a-f-]{36}$/.test(id));
}

// Starts one execution with this run's ID and action. A start override replaces the whole container, so it is copied
// from the job definition and only the three per-run variables change.
export async function startWorker(token: string, env: { JOB_ID: string; JOB_ACTION: 'preview' | 'deploy'; APPROVE?: string }): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const job = await (await armOk(fetch(`${armBase}${workerJob}?api-version=2024-03-01`, { headers }))).json();
  const container = job.properties.template.containers[0];
  const overrides: Record<string, string> = { JOB_ID: env.JOB_ID, JOB_ACTION: env.JOB_ACTION, APPROVE: env.APPROVE ?? '' };
  container.env = (container.env as { name: string; value?: string }[]).map((e) => (e.name in overrides ? { name: e.name, value: overrides[e.name] } : e));
  const started = await (await armOk(fetch(`${armBase}${workerJob}/start?api-version=2024-03-01`, { method: 'POST', headers, body: JSON.stringify({ containers: [container] }) }))).json();
  return started.name as string;
}

// The worker's managed identity, from the job definition, so the portal needs no extra setting.
let workerPrincipal: Promise<string> | null = null;
export function getWorkerPrincipalId(token: string): Promise<string> {
  workerPrincipal ??= armOk(fetch(`${armBase}${workerJob}?api-version=2024-03-01`, { headers: { Authorization: `Bearer ${token}` } }))
    .then((r) => r.json())
    .then((job) => {
      const id = (job.properties.template.containers[0].env as { name: string; value?: string }[]).find((e) => e.name === 'WORKER_PRINCIPAL_ID')?.value;
      if (!id) throw new Error('The worker job has no WORKER_PRINCIPAL_ID.');
      return id;
    })
    .catch((e) => { workerPrincipal = null; throw e; });
  return workerPrincipal;
}

const readerRole = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';
// Reader, Contributor or Owner, assigned on the subscription or above it, lets the worker generate and preview.
const readingRoles = [readerRole, 'b24988ac-6180-42a0-ab88-20f7382dd24c', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'];

export async function workerCanRead(token: string, subscriptionId: string): Promise<boolean> {
  const principalId = await getWorkerPrincipalId(token);
  const scope = `/subscriptions/${subscriptionId}`;
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const response = await armOk(fetch(`${armBase}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${filter}`, { headers: { Authorization: `Bearer ${token}` } }));
  const assignments = (await response.json()).value as { properties: { scope: string; roleDefinitionId: string } }[];
  return assignments.some((a) => {
    const assignedScope = a.properties.scope.toLowerCase();
    const inherited = assignedScope === '/' || assignedScope.startsWith('/providers/microsoft.management/managementgroups/') || assignedScope === scope.toLowerCase();
    return inherited && readingRoles.some((role) => a.properties.roleDefinitionId.toLowerCase().endsWith(role));
  });
}

// Grants the worker Reader on a subscription with the operator's rights (ADR 0018); write access comes only from Prepare.
export async function grantWorkerReader(token: string, subscriptionId: string): Promise<void> {
  const principalId = await getWorkerPrincipalId(token);
  const scope = `/subscriptions/${subscriptionId}`;
  const response = await fetch(`${armBase}${scope}/providers/Microsoft.Authorization/roleAssignments/${crypto.randomUUID()}?api-version=2022-04-01`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: {
        roleDefinitionId: `${scope}/providers/Microsoft.Authorization/roleDefinitions/${readerRole}`,
        principalId,
        principalType: 'ServicePrincipal',
        description: 'AVD Deploy portal worker: discovery and Preview.',
      },
    }),
  });
  if (response.status === 409) return; // Already assigned.
  await armOk(Promise.resolve(response));
}

export async function getExecutionState(token: string, executionName: string): Promise<string> {
  const response = await armOk(fetch(`${armBase}${workerJob}/executions/${encodeURIComponent(executionName)}?api-version=2024-03-01`, { headers: { Authorization: `Bearer ${token}` } }));
  return ((await response.json()).properties?.status as string) ?? 'Unknown';
}

async function armOk(request: Promise<Response>): Promise<Response> {
  const response = await request;
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Azure request failed with HTTP ${response.status}.`);
  }
  return response;
}

export interface RunRecord {
  jobId: string;
  createdUtc: string;
  createdBy: string;
  subscriptionId: string;
  resourceGroup: string;
  prefix: string;
  executions: { action: 'preview' | 'deploy'; name: string; startedUtc: string }[];
}

export interface WorkerStatus {
  jobId: string;
  action: 'preview' | 'deploy';
  state: 'running' | 'previewed' | 'deployed' | 'failed';
  stage: string;
  startedUtc: string;
  updatedUtc: string;
  message: string;
  ready?: boolean;
  needsFoundation?: boolean;
  resourceGroup?: string;
  planExpiresUtc?: string;
  manualTasks?: string[];
}

export interface Plan {
  createdUtc: string;
  expiresUtc: string;
  resourceGroup: string;
  sessionHosts: { count: number; vmSize: string; image: { label: string } };
  changes: { stage: string; resourceId: string; changeType: string }[];
  blockers: string[];
  warnings: string[];
}

export interface FoundationRequest {
  subscriptionId: string;
  location: string;
  resourceGroup: string;
  needed: boolean;
  missing: string[];
  unregisteredProviders: string[];
  needsAdminPassword: boolean;
  parameters: Record<string, { value: unknown }>;
  template: unknown;
}

// New-AvdAdminPassword: 24 characters with every class, from the browser's cryptographic RNG. Sent once to ARM as a
// secure parameter for the Key Vault secret; never stored by the portal.
export function newAdminPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%*+-=?@^_'];
  const all = sets.join('');
  const pick = (max: number) => {
    const limit = Math.floor(0x100000000 / max) * max;
    const buffer = new Uint32Array(1);
    do crypto.getRandomValues(buffer); while (buffer[0] >= limit);
    return buffer[0] % max;
  };
  const characters = sets.map((set) => set[pick(set.length)]);
  while (characters.length < 24) characters.push(all[pick(all.length)]);
  for (let i = characters.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }
  return characters.join('');
}

// Runs the foundation as the operator: registers missing providers, then deploys the template the worker compiled.
export async function deployFoundation(token: string, request: FoundationRequest, operatorObjectId: string, progress: (text: string) => void): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sub = `${armBase}/subscriptions/${encodeURIComponent(request.subscriptionId)}`;
  for (const namespace of request.unregisteredProviders) {
    progress(`Registering resource provider ${namespace}…`);
    await armOk(fetch(`${sub}/providers/${namespace}/register?api-version=2021-04-01`, { method: 'POST', headers }));
    for (let i = 0; ; i++) {
      const state = (await (await armOk(fetch(`${sub}/providers/${namespace}?api-version=2021-04-01`, { headers }))).json()).registrationState;
      if (state === 'Registered') break;
      if (i >= 60) throw new Error(`${namespace} is still registering; try again in a few minutes.`);
      await sleep(10000);
    }
  }
  if (!request.missing.length) return;
  const parameters: Record<string, { value: unknown }> = { ...request.parameters, operatorObjectId: { value: operatorObjectId }, operatorPrincipalType: { value: 'User' } };
  if (request.needsAdminPassword) parameters.adminPassword = { value: newAdminPassword() };
  const name = `avdv2-foundation-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  progress(`Deploying the foundation (${request.missing.join(', ')})…`);
  await armOk(fetch(`${sub}/providers/Microsoft.Resources/deployments/${name}?api-version=2024-03-01`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ location: request.location, properties: { mode: 'Incremental', template: request.template, parameters } }),
  }));
  for (;;) {
    await sleep(10000);
    const deployment = await (await armOk(fetch(`${sub}/providers/Microsoft.Resources/deployments/${name}?api-version=2024-03-01`, { headers }))).json();
    const state = deployment.properties.provisioningState as string;
    if (state === 'Succeeded') return;
    if (['Failed', 'Canceled'].includes(state)) throw new Error(`The foundation deployment ${state.toLowerCase()}: ${deployment.properties.error?.message ?? 'see the deployment in the Azure portal.'}`);
    progress(`Foundation deployment: ${state}…`);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
