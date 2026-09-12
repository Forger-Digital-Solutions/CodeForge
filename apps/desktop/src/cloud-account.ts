/**
 * Shared, electron-free account/usage IPC contract (R2 GAP-5).
 *
 * This is the single source of truth for the shape of a CodeForge Cloud account as it crosses the
 * main→preload→renderer boundary. `preload.ts` types `getCloudAccount`/`getCloudUsage` with these,
 * and the renderer (`renderer/settings/settings-context.ts`) aliases them — so there is no `any` at
 * the boundary and the two sides cannot drift.
 *
 * Every field mirrors what CodeForge Cloud's `/v1/account` actually returns. Identity fields are
 * optional and nullable: the deployed cloud may not return `identity`, and an account may
 * legitimately not share a login or email. Absent/null means "not shared" — never a fabricated or
 * guessed value (no email derived from a username, no placeholder identity).
 *
 * Kept dependency-free on purpose so both the main (NodeNext) and renderer (bundler) TS projects can
 * include it without pulling electron into the renderer program.
 */

export interface CloudAccountIdentity {
  /** GitHub username (@handle) when the connected identity reports one; null when not shared. */
  login: string | null;
  /** Authorized email the account shares; null when hidden / email scope not granted. Never guessed. */
  email: string | null;
  profileUrl: string | null;
}

export interface CloudAccountUser {
  id?: string;
  displayName?: string;
  avatarUrl?: string;
  /** Stable provider identity key (e.g. `github:<id>`). Absent for the packaged-smoke placeholder. */
  primaryIdentity?: string;
}

export interface CloudAccount {
  user?: CloudAccountUser;
  identity?: CloudAccountIdentity;
  planId?: string;
  planName?: string;
  creditBalance?: number;
  /**
   * True when CodeForge Cloud could not be reached and this is the last account the device signed
   * in as (identity only — plan and credits are unknown, never assumed). The workspace stays
   * usable with local/BYOK routes; Cloud-backed features report the outage themselves.
   */
  offline?: boolean;
}

/**
 * The account to present when Cloud is unreachable: the remembered signed-in user, marked
 * offline, with no plan or balance claimed. `null` when this device never completed a sign-in —
 * an outage must not manufacture an account.
 */
export function offlineCloudAccount(rememberedUser: unknown): CloudAccount | null {
  if (typeof rememberedUser !== "object" || rememberedUser === null) return null;
  const user = rememberedUser as CloudAccountUser;
  if (typeof user.displayName !== "string" && typeof user.id !== "string") return null;
  return { user, offline: true };
}

/** Shape of CodeForge Cloud's `/v1/usage` summary. `recentEvents` entries are opaque to the desktop. */
export interface CloudUsage {
  creditBalance: number;
  recentEvents: unknown[];
}
