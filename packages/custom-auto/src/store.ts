import type { ISessionPersistence } from "@codeforge/sessions";
import { validateCustomAutoProfile, type CustomAutoProfile } from "./profile.js";
import crypto from "node:crypto";

/**
 * Custom AUTO persistence (R1 spec §76) over the SAME ISessionPersistence abstraction every
 * other durable state uses — SQLite/PostgreSQL transparently, no second database. Profiles
 * live in the reserved account-level namespace `__custom_autos__`, never inside a user
 * session, so they survive session cleanup and restarts.
 */

export const CUSTOM_AUTO_NAMESPACE = "__custom_autos__";

export const DEFAULT_CUSTOM_AUTO_OWNER = "local-user";

function ownerKey(ownerId: string): string {
  return crypto.createHash("sha256").update(ownerId || DEFAULT_CUSTOM_AUTO_OWNER).digest("hex").slice(0, 32);
}

function profileId(ownerId: string, id: string): string {
  return `custom-auto-${ownerKey(ownerId)}-${id}`;
}

export class CustomAutoStore {
  constructor(
    private readonly persistence: ISessionPersistence,
    private readonly ownerId: string = DEFAULT_CUSTOM_AUTO_OWNER,
  ) {}

  async create(input: Omit<CustomAutoProfile, "createdAt" | "updatedAt" | "trustDomain">): Promise<CustomAutoProfile> {
    const now = new Date().toISOString();
    const candidate = { ...input, trustDomain: "USER_CUSTOM_AUTO" as const, createdAt: now, updatedAt: now };
    const validated = validateCustomAutoProfile(candidate);
    if (!validated.ok) throw new Error(`CUSTOM_AUTO_INVALID: ${validated.error}`);
    const existing = await this.get(candidate.id);
    if (existing) throw new Error(`CUSTOM_AUTO_ALREADY_EXISTS: ${candidate.id}`);
    await this.write(validated.profile);
    return validated.profile;
  }

  async get(id: string): Promise<CustomAutoProfile | undefined> {
    const item = await this.persistence.getWorkItem(profileId(this.ownerId, id));
    if (!item || item.kind !== "custom_auto_profile") return undefined;
    const validated = validateCustomAutoProfile(item.profile);
    return validated.ok ? validated.profile : undefined;
  }

  async list(): Promise<CustomAutoProfile[]> {
    const items = await this.persistence.getWorkItemsByKind("custom_auto_profile");
    const profiles: CustomAutoProfile[] = [];
    for (const item of items) {
      if (item.kind !== "custom_auto_profile") continue;
      const storedId = typeof item.profile.id === "string" ? item.profile.id : undefined;
      if (!storedId || item.id !== profileId(this.ownerId, storedId)) continue;
      const validated = validateCustomAutoProfile(item.profile);
      if (validated.ok) profiles.push(validated.profile);
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  async update(id: string, patch: Partial<Omit<CustomAutoProfile, "id" | "createdAt" | "trustDomain">>): Promise<CustomAutoProfile> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`CUSTOM_AUTO_NOT_FOUND: ${id}`);
    const candidate = { ...existing, ...patch, id: existing.id, trustDomain: existing.trustDomain, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    const validated = validateCustomAutoProfile(candidate);
    if (!validated.ok) throw new Error(`CUSTOM_AUTO_INVALID: ${validated.error}`);
    await this.write(validated.profile);
    return validated.profile;
  }

  async delete(id: string): Promise<boolean> {
    return this.persistence.deleteWorkItem(profileId(this.ownerId, id));
  }

  private async write(profile: CustomAutoProfile): Promise<void> {
    await this.persistence.upsertWorkItem({
      kind: "custom_auto_profile",
      id: profileId(this.ownerId, profile.id),
      profile: profile as unknown as Record<string, unknown>,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  }
}

export function createCustomAutoStore(
  persistence: ISessionPersistence,
  ownerId: string = DEFAULT_CUSTOM_AUTO_OWNER,
): CustomAutoStore {
  return new CustomAutoStore(persistence, ownerId);
}
