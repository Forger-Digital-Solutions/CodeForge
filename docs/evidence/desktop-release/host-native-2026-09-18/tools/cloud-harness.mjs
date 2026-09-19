// Host-native validation harness: runs the REAL CodeForge cloud-api server in-process on the
// development endpoint the packaged desktop is stamped with (http://127.0.0.1:3220), with every
// provider credential stripped from its environment (no hosted capacity, no owner keys).
//
// The only thing simulated is GitHub's authorization server, at the cloud-api's documented
// outbound `fetchFn` seam (the same seam its own test-suite uses). Two stand-in identities exist:
//   code=standin-alice -> gho_standin_alice -> login "standin-alice"  (account A)
//   code=standin-bob   -> gho_standin_bob   -> login "standin-bob"    (account B)
// A control endpoint on 127.0.0.1:3221 plays the role of the user's browser AFTER GitHub would
// have redirected: it GETs the cloud's public callback with a stand-in code and the pending
// transaction's state, then follows the 302 to the desktop's ephemeral loopback listener exactly as
// a browser would. Everything else — desktop PKCE, loopback, state check, cloud transaction store,
// code redemption, session issue/refresh/revoke, encrypted profile storage — is the production path.
//
// This is NOT a github.com round-trip. Evidence must label it as "GitHub stand-in".
//
// usage: node cloud-harness.mjs <cloud.db path> <log file>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dbPath, logFile] = process.argv.slice(2);
if (!dbPath || !logFile) throw new Error("usage: cloud-harness.mjs <cloud.db> <log>");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const log = (line) => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(logFile, entry);
  process.stdout.write(entry);
};

// Strip every provider / owner credential so the cloud has genuinely no hosted capacity and no
// paid route can be reached through this harness.
for (const key of Object.keys(process.env)) {
  if (/_API_KEY$|_TOKEN$|_SECRET$|^OPENROUTER|^GROQ|^OPENAI|^GEMINI|^GOOGLE_API|^ANTHROPIC|^CLOUDFLARE|^ZHIPU|^OPENCODE|^MISTRAL|^CEREBRAS|^GITHUB_/i.test(key)) {
    delete process.env[key];
  }
}

const repoRoot = "G:/CodeForge";
const { CodeForgeCloudServer } = await import(pathToFileURL(path.join(repoRoot, "apps/cloud-api/dist/server.js")).href);

const STANDIN = {
  "standin-alice": { token: "gho_standin_alice", id: 90000001, login: "standin-alice", name: "Stand-in Alice (account A)", avatar_url: "https://avatars.githubusercontent.com/u/90000001?v=4", email: "alice.standin@example.invalid" },
  "standin-bob": { token: "gho_standin_bob", id: 90000002, login: "standin-bob", name: "Stand-in Bob (account B)", avatar_url: "https://avatars.githubusercontent.com/u/90000002?v=4", email: "bob.standin@example.invalid" },
};
const byToken = Object.fromEntries(Object.values(STANDIN).map((u) => [u.token, u]));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** GitHub stand-in: answers only GitHub's token + profile endpoints; refuses anything else outbound. */
const standInFetch = async (url, init) => {
  const s = url.toString();
  if (s.startsWith("https://github.com/login/oauth/access_token")) {
    const body = JSON.parse(init?.body ?? "{}");
    const user = STANDIN[body.code];
    log(`[github-standin] token exchange code=${body.code} client_id=${body.client_id} -> ${user ? "ok" : "bad_verification_code"}`);
    if (!user) return json({ error: "bad_verification_code" }, 200);
    return json({ access_token: user.token, token_type: "bearer", scope: "read:user user:email" });
  }
  const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? "";
  const user = byToken[String(auth).replace(/^(Bearer|token)\s+/i, "")];
  if (s.startsWith("https://api.github.com/user/emails")) {
    log(`[github-standin] /user/emails for ${user?.login ?? "unknown"}`);
    if (!user) return json({ message: "Bad credentials" }, 401);
    return json([{ email: user.email, primary: true, verified: true, visibility: "private" }]);
  }
  if (s.startsWith("https://api.github.com/user")) {
    log(`[github-standin] /user for ${user?.login ?? "unknown"}`);
    if (!user) return json({ message: "Bad credentials" }, 401);
    return json({ id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url, email: null });
  }
  log(`[github-standin] REFUSED outbound fetch ${s}`);
  throw new Error(`harness refuses outbound fetch to ${s}`);
};

const server = new CodeForgeCloudServer({
  host: "127.0.0.1",
  port: 3220,
  driver: "sqlite",
  dbPath,
  jwtSecret: "codeforge-cloud-test-jwt-secret-key-32chars", // cloud-api development default
  gitHubClientId: "codeforge-local-github-standin",
  gitHubClientSecret: "not-a-real-secret-github-standin",
  publicUrl: "http://127.0.0.1:3220",
  stripeConfig: null,
  fetchFn: standInFetch,
  logLevel: "info",
});
const port = await server.start(3220, "127.0.0.1");
log(`[harness] real cloud-api listening on http://127.0.0.1:${port} (sqlite ${dbPath}); hosted capacity: none; GitHub: STAND-IN`);

// --- control endpoint: plays the browser after "GitHub" redirects -------------------------------
// Node 24's built-in sqlite (the same driver @codeforge/cloud-db prefers) for read-only inspection.
const { DatabaseSync } = await import("node:sqlite");
function latestPendingState() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT state, redirect_uri, created_at FROM oauth_transactions WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1").get();
  } finally { db.close(); }
}
function snapshot() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      users: db.prepare("SELECT id, display_name, primary_identity, created_at FROM users ORDER BY created_at").all(),
      sessions: db.prepare("SELECT id, user_id, device_name, revoked_at, created_at, last_seen_at FROM device_sessions ORDER BY created_at").all(),
      transactions: db.prepare("SELECT state IS NOT NULL AS has_state, redirect_uri, used_at, created_at FROM oauth_transactions ORDER BY created_at").all(),
    };
  } finally { db.close(); }
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:3221");
  const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body, null, 2)); };
  try {
    if (url.pathname === "/complete") {
      const who = url.searchParams.get("who") ?? "";
      if (!STANDIN[who]) return reply(400, { error: "who must be standin-alice or standin-bob" });
      const tx = latestPendingState();
      if (!tx) return reply(409, { error: "no pending desktop OAuth transaction" });
      log(`[browser-role] completing pending transaction (redirect_uri=${tx.redirect_uri}) as ${who}`);
      // 1. What the browser does when GitHub redirects back to the cloud's public callback.
      const cb = await fetch(`http://127.0.0.1:3220/v1/auth/github/callback?code=${encodeURIComponent(who)}&state=${encodeURIComponent(tx.state)}`, { redirect: "manual" });
      const location = cb.headers.get("location");
      log(`[browser-role] cloud callback -> ${cb.status} location=${location ? new URL(location).origin + new URL(location).pathname + " (params: " + [...new URL(location).searchParams.keys()].join(",") + ")" : "none"}`);
      if (cb.status !== 302 || !location) return reply(502, { error: "cloud callback did not redirect", status: cb.status });
      // 2. The browser follows the 302 to the desktop's ephemeral loopback listener.
      const loop = await fetch(location, { redirect: "manual" });
      const text = await loop.text();
      log(`[browser-role] desktop loopback -> ${loop.status} (${text.length} bytes)`);
      return reply(200, { who, cloudCallbackStatus: cb.status, loopbackStatus: loop.status, loopbackBodyPreview: text.slice(0, 200) });
    }
    if (url.pathname === "/snapshot") return reply(200, snapshot());
    if (url.pathname === "/stop") { reply(200, { stopping: true }); setTimeout(async () => { await server.stop(); control.close(); process.exit(0); }, 100); return; }
    reply(404, { error: "unknown control route" });
  } catch (error) {
    log(`[control] error ${error instanceof Error ? error.message : String(error)}`);
    reply(500, { error: String(error) });
  }
});
control.listen(3221, "127.0.0.1", () => log("[harness] control endpoint on http://127.0.0.1:3221 (/complete?who=standin-alice|standin-bob, /snapshot, /stop)"));
process.on("SIGINT", async () => { await server.stop(); process.exit(0); });
