export function deploymentIdentity(env: Readonly<Record<string, string | undefined>>): { commit: string | null; serviceId: string | null } {
  return {
    commit: /^[a-f0-9]{40}$/i.test(env.RENDER_GIT_COMMIT ?? "") ? env.RENDER_GIT_COMMIT! : null,
    serviceId: /^srv-[a-z0-9]{1,64}$/.test(env.RENDER_SERVICE_ID ?? "") ? env.RENDER_SERVICE_ID! : null,
  };
}
