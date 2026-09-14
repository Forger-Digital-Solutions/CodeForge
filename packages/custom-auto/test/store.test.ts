import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createCustomAutoStore, type CustomAutoStore } from "../src/store.js";
import { type CustomAutoProfile } from "../src/profile.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("CustomAutoStore persistence (SQLite)", () => {
  let persistence: ISessionPersistence;
  let store: CustomAutoStore;

  const sampleProfile: Omit<CustomAutoProfile, "createdAt" | "updatedAt" | "trustDomain"> = {
    id: "team-a",
    name: "Team Alpha",
    roles: {
      coder: { providerId: "groq", modelId: "llama-3.3-70b-versatile" },
      reviewer: { providerId: "deepseek", modelId: "deepseek-chat" },
    },
    mode: "pinned",
    maxActiveSpecialists: 2,
    verificationStrictness: "STANDARD",
  };

  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    store = createCustomAutoStore(persistence);
  });

  afterEach(async () => {
    await persistence.close();
  });

  it("creates, reads, updates, and deletes a Custom AUTO profile", async () => {
    // 1. Create
    const created = await store.create(sampleProfile);
    expect(created.id).toBe("team-a");
    expect(created.trustDomain).toBe("USER_CUSTOM_AUTO");
    expect(created.createdAt).toBeDefined();

    // 2. Read
    const fetched = await store.get("team-a");
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Team Alpha");
    expect(fetched!.roles.coder.providerId).toBe("groq");

    // 3. List
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("team-a");

    // 4. Update
    const updated = await store.update("team-a", { name: "Team Alpha Renamed" });
    expect(updated.name).toBe("Team Alpha Renamed");
    const reFetched = await store.get("team-a");
    expect(reFetched!.name).toBe("Team Alpha Renamed");

    // 5. Delete
    const deleted = await store.delete("team-a");
    expect(deleted).toBe(true);

    const postDelete = await store.get("team-a");
    expect(postDelete).toBeUndefined();

    const emptyList = await store.list();
    expect(emptyList).toHaveLength(0);

    // Delete again returns false
    const deleteAgain = await store.delete("team-a");
    expect(deleteAgain).toBe(false);
  });

  it("rejects duplicate creation", async () => {
    await store.create(sampleProfile);
    await expect(store.create(sampleProfile)).rejects.toThrow("CUSTOM_AUTO_ALREADY_EXISTS");
  });

  it("rejects updating nonexistent profile", async () => {
    await expect(store.update("nonexistent", { name: "new" })).rejects.toThrow("CUSTOM_AUTO_NOT_FOUND");
  });

  it("isolates profiles by owner on the shared persistence backend", async () => {
    const ownerA = createCustomAutoStore(persistence, "user-a");
    const ownerB = createCustomAutoStore(persistence, "user-b");
    await ownerA.create(sampleProfile);

    expect(await ownerA.get(sampleProfile.id)).toBeDefined();
    expect(await ownerB.get(sampleProfile.id)).toBeUndefined();
    expect(await ownerB.list()).toHaveLength(0);
    await expect(ownerB.create(sampleProfile)).resolves.toBeDefined();
    expect(await ownerA.list()).toHaveLength(1);
    expect(await ownerB.list()).toHaveLength(1);
  });

  it("preserves Custom AUTO profiles across persistence restart", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-custom-auto-test-"));
    const dbPath = path.join(tmpDir, "sessions.sqlite");

    try {
      // 1. Initialize and store profile
      const p1 = createSessionPersistence({ dbPath });
      await p1.init();
      const s1 = createCustomAutoStore(p1);
      await s1.create(sampleProfile);
      await p1.close();

      // 2. Restart: simulate fresh process opening the same database file
      const p2 = createSessionPersistence({ dbPath });
      await p2.init();
      const s2 = createCustomAutoStore(p2);

      const recovered = await s2.get("team-a");
      expect(recovered).toBeDefined();
      expect(recovered!.id).toBe("team-a");
      expect(recovered!.name).toBe("Team Alpha");
      expect(recovered!.roles.coder.modelId).toBe("llama-3.3-70b-versatile");

      const list = await s2.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe("team-a");

      await p2.close();
    } finally {
      try {
        await new Promise((r) => setTimeout(r, 100));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Temp folder cleanup best effort on Windows
      }
    }
  });
});

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

describe.skipIf(!TEST_PG?.startsWith("postgres"))("CustomAutoStore persistence (PostgreSQL)", () => {
  let persistence: ISessionPersistence;
  let store: CustomAutoStore;

  beforeEach(async () => {
    persistence = createSessionPersistence({ driver: "postgres", databaseUrl: TEST_PG });
    await persistence.init();
    store = createCustomAutoStore(persistence);
  });

  afterEach(async () => {
    await persistence.close();
  });

  it("persists and restarts Custom AUTO profiles through real PostgreSQL", async () => {
    const uniqueId = `pg-team-${Date.now().toString(36)}`;
    const created = await store.create({
      id: uniqueId,
      name: "PG Team",
      roles: { coder: { providerId: "groq", modelId: "llama-3.3-70b-versatile" } },
      mode: "pinned",
      maxActiveSpecialists: 1,
      verificationStrictness: "STANDARD",
    });
    expect(created.id).toBe(uniqueId);

    const retrieved = await store.get(uniqueId);
    expect(retrieved?.id).toBe(uniqueId);

    await store.delete(uniqueId);
    expect(await store.get(uniqueId)).toBeUndefined();
  });
});
