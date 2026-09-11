// qualification-fixtures/multi-file/src/user.ts
export interface User {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
}

export function createUser(name: string, email: string, roleIds: string[]): User {
  return {
    id: crypto.randomUUID(),
    name,
    email,
    roleIds,
  };
}