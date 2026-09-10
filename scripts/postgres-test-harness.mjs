import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const LOCAL_TEST_URL = "postgresql://codeforge_test:cf_test_pass_123@127.0.0.1:5432/codeforge_test_db";
const READY_ATTEMPTS = 8;
const CONNECTION_TIMEOUT_MS = 1_500;
const TCP_PROBE_TIMEOUT_MS = 1_000;

function endpointLabel(connectionString) {
  const url = new URL(connectionString);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function assertPostgresUrl(connectionString) {
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("CODEFORGE_TEST_POSTGRES_URL must use postgres:// or postgresql://.");
  }
  return url;
}

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

function startLocalKeeper() {
  return spawn(
    "wsl.exe",
    ["--cd", "/tmp", "-u", "root", "-d", "Ubuntu", "--exec", "bash", "-lc", "service postgresql start && exec sleep 3600"],
    { stdio: "ignore", windowsHide: true },
  );
}

async function bootstrapLocalPostgres() {
  await spawnAndWait(process.execPath, ["scripts/setup-local-pg.mjs"], { stdio: "ignore", windowsHide: true });
}

async function queryReadiness(connectionString, expectedDatabase) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: CONNECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query("SELECT 1 AS ready, current_database() AS database");
    if (result.rows[0]?.ready !== 1 || result.rows[0]?.database !== expectedDatabase) {
      throw new Error(`Expected ready database ${expectedDatabase}, received ${String(result.rows[0]?.database ?? "unknown")}.`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function wslReadiness() {
  try {
    await spawnAndWait(
      "wsl.exe",
      ["--cd", "/tmp", "-u", "root", "-d", "Ubuntu", "--exec", "pg_isready", "-h", "127.0.0.1", "-p", "5432"],
      { stdio: "ignore", windowsHide: true },
    );
    return "running";
  } catch {
    return "not-running";
  }
}

async function waitForReadiness(connectionString, local) {
  const url = assertPostgresUrl(connectionString);
  const expectedDatabase = decodeURIComponent(url.pathname.replace(/^\//, ""));
  let lastError = new Error("No SQL readiness attempt was made.");

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      await queryReadiness(connectionString, expectedDatabase);
      console.log(`PostgreSQL test endpoint ready: ${endpointLabel(connectionString)}`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt + 1 < READY_ATTEMPTS) await delay(Math.min(250 * 2 ** attempt, 2_000));
    }
  }

  const tcp = await tcpProbe(url.hostname, Number(url.port || 5432));
  const wsl = local ? await wslReadiness() : "not-applicable";
  throw new Error(
    [
      "PostgreSQL test endpoint unreachable:",
      endpointLabel(connectionString),
      `WSL service: ${wsl}`,
      `Windows TCP probe: ${tcp ? "pass" : "fail"}`,
      `SQL readiness: fail (${lastError.message})`,
    ].join("\n"),
  );
}

function runTestCommand(command, args, connectionString) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, CODEFORGE_TEST_POSTGRES_URL: connectionString },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`PostgreSQL test command exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

const separator = process.argv.indexOf("--");
const testCommand = separator === -1 ? [] : process.argv.slice(separator + 1);
const suppliedUrl = process.env.CODEFORGE_TEST_POSTGRES_URL;
const local = !suppliedUrl;
const connectionString = suppliedUrl ?? LOCAL_TEST_URL;
let keeper;

try {
  if (local) {
    if (process.platform !== "win32") {
      throw new Error("Local PostgreSQL bootstrap is supported only on Windows with WSL Ubuntu. Set CODEFORGE_TEST_POSTGRES_URL for another endpoint.");
    }
    keeper = startLocalKeeper();
    keeper.once("error", (error) => console.error(`WSL keeper error: ${error.message}`));
    await bootstrapLocalPostgres();
  }

  await waitForReadiness(connectionString, local);
  if (testCommand.length > 0) await runTestCommand(testCommand[0], testCommand.slice(1), connectionString);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (keeper && !keeper.killed) keeper.kill();
}
