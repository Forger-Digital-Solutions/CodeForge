import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";
import { SqliteQualificationPersistence } from "../src/qualification/persistence.js";

it("persists a provider qualification budget across SQLite close/reopen without making it a model receipt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-qualification-spend-"));
  const dbPath = path.join(directory, "host.sqlite");
  let persistence = createSessionPersistence({ dbPath });
  const spend = { providerId: "fixture-provider", day: "2026-10-05", requests: 24, lastCycleAt: 1791210000000, recoveries: 1 };
  try {
    await new SqliteQualificationPersistence(persistence).saveSpend(spend);
    persistence.close();
    persistence = createSessionPersistence({ dbPath });
    const store = new SqliteQualificationPersistence(persistence);
    expect(await store.loadSpend()).toEqual([spend]);
    expect(await store.loadAll()).toEqual([]);
    await store.saveSpend({ ...spend, day: "2026-10-06", requests: 3, recoveries: 0 });
    expect(await store.loadSpend()).toEqual([{ ...spend, day: "2026-10-06", requests: 3, recoveries: 0 }]);
  } finally {
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
