// CF-17 spawned-process restart fixture. This file runs as a REAL separate Node process
// (never in-process) and boots the production CodeForgeServer with PostgreSQL selected through
// the canonical environment configuration (CODEFORGE_SESSIONS_DB_DRIVER /
// CODEFORGE_SESSIONS_DATABASE_URL), exactly as a production deployment would.
//
// argv[2]: "first" (stream hangs so the turn stays active until the process is killed) or
//          "second" (streams a replanned completion).
// argv[3]: path of the boot file the parent polls; receives {"port":N,"driver":"postgres"}.
// argv[4]: path of the request ledger; every model request appends one JSONL line, giving the
//          parent a deterministic replay-detection side effect that lives outside any process.
import { writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "../../dist/index.js";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";

const [, , mode, bootFile, ledgerFile] = process.argv;

const catalog = new InMemoryProviderCatalog();
catalog.register({
  providerId: "codeforge",
  displayName: mode === "first" ? "First attempt provider" : "Recovered attempt provider",
  isTestProvider: false,
  models: () => [createGenericFreeRecord()],
  streamChat: (request) => {
    appendFileSync(ledgerFile, JSON.stringify({
      pid: process.pid,
      mode,
      contents: request.messages.map((message) => message.content),
    }) + "\n");
    if (mode === "first") {
      return (async function* () {
        yield { type: "text_delta", delta: "first attempt started" };
        await new Promise(() => {});
      })();
    }
    return (async function* () {
      yield { type: "text_delta", delta: "replanned after restart" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
});

const server = createServer({
  port: 0,
  providerCatalog: catalog,
  useRealRuntime: true,
});

await server.start();
writeFileSync(bootFile, JSON.stringify({ port: server.httpPort, driver: server.persistence.getDriver() }));
