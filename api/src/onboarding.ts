// Onboard subscription (ADR 0019, docs/hosted-service.md step 4). Everything here runs with the operator's own Azure
// token, so Azure itself enforces that they may grant access. AKC's app only ever receives rights on the one resource
// group, plus AVD's own power-management role at subscription scope when autoscale is used.
import { createHash } from 'node:crypto';
import type { OnboardingArm, RoleAssignment } from './arm.ts';

export const avdProviders = ['Microsoft.DesktopVirtualization', 'Microsoft.Compute', 'Microsoft.Network', 'Microsoft.Storage', 'Microsoft.KeyVault'];

const contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6';
const rbacAdministrator = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168';
const powerOnOffContributor = '40c5ff49-9181-41f8-ae61-143b0e78555e';

// The roles the workload templates (infra/avd) assign; test/onboarding.test.ts fails if the templates change.
export const assignableRoles = [
  '1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63', // Desktop Virtualization User
  'fb879df8-f326-4884-b1cf-06f3ad86be52', // Virtual Machine User Login
  '1c0163c0-47e6-4577-8991-ea5c82e286e4', // Virtual Machine Administrator Login
  '489581de-a3bd-480d-9518-53dea7416b33', // Desktop Virtualization Power On Contributor
  '0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb', // Storage File Data SMB Share Contributor
  'a7264617-510b-434b-a828-9731dc254ea7', // Storage File Data SMB Share Elevated Contributor
];

// Assign or remove only those roles, and assign them only to groups and service principals (never users, never itself
// a broader role).
const roleList = assignableRoles.join(', ');
export const assignmentCondition =
  `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR ` +
  `(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${roleList}} AND ` +
  `@Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'Group', 'ServicePrincipal'})) AND ` +
  `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR ` +
  `(@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${roleList}}))`;

export type ActionStatus = 'done' | 'todo' | 'in-progress' | 'blocked';

export interface OnboardingAction {
  id: 'providers' | 'resource-group' | 'contributor' | 'key-vault' | 'limited-rbac' | 'power-role';
  title: string;
  detail: string;
  status: ActionStatus;
  message?: string;
}

export interface OnboardingRequest {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  scaling: boolean;
}

export interface OnboardingContext {
  token: string;
  arm: OnboardingArm;
  appObjectId: string;
  /** Object ID of the Azure Virtual Desktop service principal; only needed when scaling. */
  avdObjectId: string | null;
}

/** Fixed assignment names, so applying twice never creates duplicates. */
export function assignmentName(scope: string, principalId: string, roleId: string): string {
  const hex = createHash('sha256').update(`${scope.toLowerCase()}|${principalId.toLowerCase()}|${roleId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const conditionCovers = (condition: string) => assignableRoles.every((role) => condition.toLowerCase().includes(role)) && /PrincipalType/i.test(condition);

function resourceGroupScope(request: OnboardingRequest) {
  return `/subscriptions/${request.subscriptionId}/resourceGroups/${request.resourceGroup}`;
}

/** Reads the current state of every onboarding action. Changes nothing. */
export async function checkOnboarding(request: OnboardingRequest, context: OnboardingContext): Promise<OnboardingAction[]> {
  const { token, arm } = context;
  const states = await Promise.all(avdProviders.map(async (ns) => [ns, await arm.providerState(token, request.subscriptionId, ns)] as const));
  const unregistered = states.filter(([, state]) => state !== 'Registered');
  const registering = unregistered.filter(([, state]) => state === 'Registering');
  const actions: OnboardingAction[] = [{
    id: 'providers',
    title: 'Register the Azure services AVD uses',
    detail: avdProviders.join(', '),
    status: unregistered.length === 0 ? 'done' : registering.length === unregistered.length ? 'in-progress' : 'todo',
    ...(unregistered.length ? { message: `${unregistered.map(([ns, state]) => `${ns} (${state})`).join(', ')}` } : {}),
  }];

  const location = await arm.resourceGroupLocation(token, request.subscriptionId, request.resourceGroup);
  const groupClash = location !== null && location.toLowerCase() !== request.location;
  actions.push({
    id: 'resource-group',
    title: `Create resource group ${request.resourceGroup}`,
    detail: `In ${request.location}. Everything AVD Deploy builds goes here.`,
    status: groupClash ? 'blocked' : location ? 'done' : 'todo',
    ...(groupClash ? { message: `It already exists in ${location}. Choose that region or another name.` } : location ? { message: 'Already exists.' } : {}),
  });

  const scope = resourceGroupScope(request);
  const appRoles: RoleAssignment[] = location ? await arm.roleAssignments(token, scope, context.appObjectId) : [];
  const has = (roleId: string) => appRoles.filter((a) => a.roleId === roleId);
  const limited = has(rbacAdministrator);
  actions.push(
    { id: 'contributor', title: 'Let AKC AVD Deploy build in this resource group', detail: 'Contributor on the resource group only.', status: has(contributor).length ? 'done' : 'todo' },
    { id: 'key-vault', title: 'Let it read the session host password it creates', detail: 'Key Vault Secrets User on the resource group only.', status: has(keyVaultSecretsUser).length ? 'done' : 'todo' },
    {
      id: 'limited-rbac',
      title: 'Let it give your users access to the desktop',
      detail: 'Role Based Access Control Administrator on the resource group, limited to the six AVD access roles and to groups and service principals.',
      status: limited.some((a) => a.condition && conditionCovers(a.condition)) ? (limited.some((a) => !a.condition) ? 'blocked' : 'done') : limited.some((a) => !a.condition) ? 'blocked' : 'todo',
      ...(limited.some((a) => !a.condition) ? { message: 'AKC AVD Deploy already has an unrestricted role-assignment right on this resource group. Remove it in the Azure portal; AVD Deploy only accepts the limited one.' } : {}),
    },
  );

  if (request.scaling) {
    const subscriptionScope = `/subscriptions/${request.subscriptionId}`;
    const power = context.avdObjectId ? (await arm.roleAssignments(token, subscriptionScope, context.avdObjectId)).some((a) => a.roleId === powerOnOffContributor) : false;
    actions.push({
      id: 'power-role',
      title: 'Let Azure Virtual Desktop start and stop hosts on a schedule',
      detail: "Microsoft's Desktop Virtualization Power On Off Contributor for the Azure Virtual Desktop service, at subscription scope (required for autoscale).",
      status: !context.avdObjectId ? 'blocked' : power ? 'done' : 'todo',
      ...(!context.avdObjectId ? { message: 'The Azure Virtual Desktop service principal was not found in this tenant yet; it appears after Microsoft.DesktopVirtualization is registered.' } : {}),
    });
  }
  return actions;
}

/** Does every outstanding action that can be done now, in order. Safe to repeat. */
export async function applyOnboarding(request: OnboardingRequest, context: OnboardingContext, actions: OnboardingAction[]): Promise<void> {
  const { token, arm } = context;
  const todo = (id: OnboardingAction['id']) => actions.find((a) => a.id === id)?.status === 'todo';
  if (actions.some((a) => a.status === 'blocked' && a.id !== 'power-role')) return;

  if (todo('providers')) {
    for (const ns of avdProviders) {
      if ((await arm.providerState(token, request.subscriptionId, ns)) === 'NotRegistered') await arm.registerProvider(token, request.subscriptionId, ns);
    }
  }
  if (todo('resource-group')) await arm.createResourceGroup(token, request.subscriptionId, request.resourceGroup, request.location);

  const scope = resourceGroupScope(request);
  const grant = (roleId: string, description: string, condition?: string) =>
    arm.assignRole(token, scope, { name: assignmentName(scope, context.appObjectId, roleId), roleId, principalId: context.appObjectId, principalType: 'ServicePrincipal', description, ...(condition ? { condition } : {}) });
  if (todo('contributor')) await grant(contributor, 'AVD Deploy (Andy Kemp Consulting): build AVD in this resource group.');
  if (todo('key-vault')) await grant(keyVaultSecretsUser, 'AVD Deploy: read the session host admin password it stores here.');
  if (todo('limited-rbac')) await grant(rbacAdministrator, 'AVD Deploy: assign only the AVD access roles, only to groups and service principals.', assignmentCondition);

  if (todo('power-role') && context.avdObjectId) {
    const subscriptionScope = `/subscriptions/${request.subscriptionId}`;
    await arm.assignRole(token, subscriptionScope, {
      name: assignmentName(subscriptionScope, context.avdObjectId, powerOnOffContributor),
      roleId: powerOnOffContributor,
      principalId: context.avdObjectId,
      principalType: 'ServicePrincipal',
      description: 'Azure Virtual Desktop autoscale (granted by AVD Deploy onboarding).',
    });
  }
}
