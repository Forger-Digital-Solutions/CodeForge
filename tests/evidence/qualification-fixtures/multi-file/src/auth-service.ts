// qualification-fixtures/multi-file/src/auth-service.ts
import { User } from "./user.js";
import { getPermissionsForUser } from "./roles.js";

export interface AuthContext {
  user: User;
  permissions: string[];
}

export function createAuthContext(user: User): AuthContext {
  return {
    user,
    permissions: getPermissionsForUser(user.roleIds),
  };
}

export function canAccess(context: AuthContext, requiredPermission: string): boolean {
  return context.permissions.includes(requiredPermission);
}