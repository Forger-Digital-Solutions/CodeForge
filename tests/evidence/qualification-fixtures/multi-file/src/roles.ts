// qualification-fixtures/multi-file/src/roles.ts
export interface Role {
  id: string;
  name: string;
  permissions: string[];
}

export const ROLES: Role[] = [
  { id: "admin", name: "Administrator", permissions: ["read", "write", "delete", "admin"] },
  { id: "editor", name: "Editor", permissions: ["read", "write"] },
  { id: "viewer", name: "Viewer", permissions: ["read"] },
];

export function getRoleById(id: string): Role | undefined {
  return ROLES.find(r => r.id === id);
}

export function getPermissionsForUser(roleIds: string[]): string[] {
  const permissions = new Set<string>();
  for (const roleId of roleIds) {
    const role = getRoleById(roleId);
    if (role) {
      for (const p of role.permissions) {
        permissions.add(p);
      }
    }
  }
  return Array.from(permissions);
}