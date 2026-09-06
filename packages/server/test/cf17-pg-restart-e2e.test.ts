import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Real spawned-process restart proof (CF-17 §21-22): two REAL server processes, REAL PostgreSQL,
// no shared memory. PostgreSQL is selected through the canonical production environment variables
// (CODEFORGE_SESSIONS_DB_DRIVER / CODEFORGE_SESSIONS_DATABASE_URL), not through test wiring.
const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

const CHILD_SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "cf17-pg-restart-child.mjs");
const E2E_DB_NAME = "cf17_restart_e2e";

function urlForDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

interface BootInfo { port: number; driver: string }

async function spawnServer(mode: "first" | "second", dbUrl: string, bootFile: string, ledgerFile: string): Promise<{ child: ChildProcess; boot: BootInfo }> {
  const child = spawn(process.execPath, [CHILD_SCRIPT, mode, bootFile, ledgerFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEFORGE_SESSIONS_DB_DRIVER: "postgres",
      CODEFORGE_SESSIONS_DATABASE_URL: dbUrl,
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); if (process.env.CF17_DEBUG) console.error(`[child ]`, String(chunk)); });
  const boot = await new Promise<BootInfo>((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => rejectBoot(new Error(`child (${mode}) did not boot in time. stderr: ${stderr.slice(-2000)}`)), 60_000);
    const poll = async (): Promise<void> => {
      if (child.exitCode !== null) {
        clearTimeout(timer);
        rejectBoot(new Error(`child (${mode}) exited early with code ${child.exitCode}. stderr: ${stderr.slice(-2000)}`));
        return;
      }
      try {
        const parsed = JSON.parse(await readFile(bootFile, "utf8")) as BootInfo;
        clearTimeout(timer);
        resolveBoot(parsed);
        return;
      } catch {
        setTimeout(() => void poll(), 100);
      }
    };
    void poll();
  });
  return { child, boot };
}

async function request(port: number, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

describe.skipIf(!TEST_PG?.startsWith("postgres"))("CF-17 spawned-process restart with queued steer against real PostgreSQL", () => {
  let childA: ChildProcess | undefined;
  let childB: ChildProcess | undefined;
  let root: string | undefined;
  let admin: pg.Client | undefined;

  afterEach(async () => {
    if (process.env.CF17_KEEP_DB) return;
    for (const child of [childA, childB]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    childA = childB = undefined;
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      admin = undefined;
    }
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  }, 30_000);

  it("kills a real server process and a fresh process hydrates, replans with the queued steer exactly once, and never replays", async () => {
    root = await mkdtemp(join(tmpdir(), "cf17-pg-restart-"));
    const bootFile = join(root, "boot.json");
    const ledgerFile = join(root, "ledger.jsonl");
    const dbUrl = urlForDatabase(TEST_PG!, E2E_DB_NAME);

    // Dedicated disposable database: created fresh, dropped on teardown (no leaked records).
    admin = new pg.Client({ connectionString: urlForDatabase(TEST_PG!, "postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${E2E_DB_NAME} OWNER codeforge_test`);

    // ---- Process A: real production server on real PostgreSQL ----
    const a = await spawnServer("first", dbUrl, bootFile, ledgerFile);
    childA = a.child;
    // PostgreSQL persistence selected through production configuration, not test wiring.
    expect(a.boot.driver).toBe("postgres");
    const portA = a.boot.port;

    const started = await request(portA, "/api/send", { sessionId: "cf17-pg-restart", message: "implement original behavior" });
    expect(started.status).toBe(200);
    const turnId = started.body.turnId as string;
    await waitFor(
      async () => (await request(portA, `/api/sessions/cf17-pg-restart`)).body,
      (snapshot) => snapshot.turns?.some((turn: { id: string; status: string }) => turn.id === turnId && turn.status === "running"),
      "process A turn did not become active",
    );

    const steered = await request(portA, "/api/send", { sessionId: "cf17-pg-restart", message: "use revised behavior", steer: true, steerId: "pg-restart-steer" });
    expect(steered).toMatchObject({ status: 200, body: { ok: true, steered: true, turnId } });

    // Durability before the kill: session, nonterminal turn, and the steer receipt exist in
    // real PostgreSQL, and the steer is queued exactly once.
    const verify = new pg.Client({ connectionString: dbUrl });
    await verify.connect();
    const receiptRows = await verify.query(`SELECT id FROM work_items WHERE kind = 'steer_receipt'`);
    expect(receiptRows.rows).toHaveLength(1);
    const turnRows = await verify.query(`SELECT id, status FROM turns WHERE id = $1`, [turnId]);
    expect(turnRows.rows).toEqual([expect.objectContaining({ id: turnId, status: "running" })]);
    await verify.end();

    // ---- Kill A (SIGKILL: no graceful shutdown, exactly like a crashed process) ----
    childA.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      childA.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await expect(request(portA, "/api/sessions/cf17-pg-restart")).rejects.toThrow();
    expect(existsSync(bootFile)).toBe(true);
    await rm(bootFile, { force: true });

    // ---- Process B: a fresh real process over the same PostgreSQL ----
    const b = await spawnServer("second", dbUrl, bootFile, ledgerFile);
    childB = b.child;
    expect(b.boot.driver).toBe("postgres");
    const portB = b.boot.port;

    // B hydrates the same turn and makes the recovered state explicit; it never claims "running".
    const hydrated = await waitFor(
      async () => (await request(portB, `/api/sessions/cf17-pg-restart`)).body,
      (snapshot) => snapshot.turns?.some((turn: { id: string; status: string }) => turn.id === turnId && turn.status === "recovering"),
      "process B did not hydrate the interrupted turn as recovering",
    );
    expect(hydrated.turns).toHaveLength(1);
    const recoveryItem = hydrated.workItems.find((item: { kind: string }) => item.kind === "agent_turn_recovery");
    expect(recoveryItem).toMatchObject({ state: "replan_required", generation: 1 });

    // The queued steer survived the kill, attached to its steerId, still queued exactly once.
    const holdItem = hydrated.workItems.find((item: { kind: string }) => item.kind === "user_intent_hold");
    expect(holdItem?.queuedSteers).toEqual([expect.objectContaining({ steerId: "pg-restart-steer", message: "use revised behavior" })]);

    // Resume in B: replan, never replay. The ledger is the deterministic side effect.
    const resumed = await request(portB, `/api/sessions/cf17-pg-restart/turns/${turnId}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await waitFor(
      async () => (await request(portB, `/api/sessions/cf17-pg-restart`)).body,
      (snapshot) => snapshot.turns?.some((turn: { id: string; status: string }) => turn.id === turnId && turn.status === "completed"),
      "recovered turn did not complete in process B",
    );
    expect((hydrated.workItems.find((item: { kind: string }) => item.kind === "agent_turn_recovery") ?? hydrated)).toBeDefined();
    const settled = await request(portB, `/api/sessions/cf17-pg-restart`);
    expect(settled.body.workItems.find((item: { kind: string }) => item.kind === "agent_turn_recovery")).toMatchObject({ state: "resumed" });

    const ledger = (await readFile(ledgerFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; mode: string; contents: string[] });
    // Exactly two model requests total: the original in A, the replan in B. A replayed command
    // would produce a third ledger line.
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.mode).toBe("first");
    expect(ledger[1]!.mode).toBe("second");
    expect(ledger[1]!.pid).not.toBe(ledger[0]!.pid);
    const replanText = ledger[1]!.contents.join("\n");
    expect(replanText).toContain("Recovery directive");
    expect(replanText).toContain("use revised behavior");
    // The steer was consumed exactly once: drained from the durable queue, one receipt remains.
    const settledHold = settled.body.workItems.find((item: { kind: string }) => item.kind === "user_intent_hold");
    expect(settledHold?.queuedSteers).toEqual([]);
    const reconcileEvents = settled.body.events.filter((event: { type: string }) => event.type === "user_intent_steer.reconciliation_completed");
    expect(reconcileEvents).toHaveLength(1);

    // A later turn in B receives no stale steer and no recovery directive.
    const next = await request(portB, "/api/send", { sessionId: "cf17-pg-restart", message: "A later unrelated turn" });
    expect(next.status).toBe(200);
    await waitFor(
      async () => (await request(portB, `/api/sessions/cf17-pg-restart`)).body,
      (snapshot) => snapshot.turns?.filter((turn: { status: string }) => turn.status === "completed").length === 2,
      "later turn did not complete",
    );
    const finalLedger = (await readFile(ledgerFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { mode: string; contents: string[] });
    expect(finalLedger).toHaveLength(3);
    expect(finalLedger[2]!.contents.join("\n")).not.toContain("use revised behavior");
    expect(finalLedger[2]!.contents.join("\n")).not.toContain("Recovery directive");

    await childB.kill("SIGKILL");
    childB = undefined;
  }, 180_000);
});
