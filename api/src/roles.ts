// AVD roles live in the control plane, not in Clerk (ADR 0018). A member can hold several.
export const avdRoles = ['reader', 'operator', 'approver', 'admin'] as const;
export type AvdRole = (typeof avdRoles)[number];

export type AvdPermission = 'read' | 'operate' | 'approve' | 'admin';

const rolePermissions: Record<AvdRole, AvdPermission[]> = {
  reader: ['read'],
  operator: ['read', 'operate'],
  approver: ['read', 'approve'],
  admin: ['read', 'operate', 'approve', 'admin'],
};

export function permissionsFor(roles: readonly AvdRole[]): AvdPermission[] {
  return [...new Set(roles.flatMap((role) => rolePermissions[role]))].sort();
}

export function isAvdRole(value: unknown): value is AvdRole {
  return typeof value === 'string' && (avdRoles as readonly string[]).includes(value);
}
