import http from "node:http";
import crypto from "node:crypto";

/**
 * Local development identity-provider double for GitHub OAuth (zero-setup R1 certification rig).
 *
 * This exists because a dev machine has no registered CodeForge GitHub OAuth App. It doubles ONLY
 * github.com's four OAuth/profile endpoints so the entire CodeForge-side flow — desktop PKCE,
 * cloud transaction store, token exchange, profile fetch, JWT minting, entitlement, ledger — runs
 * as real production code. It never touches github.com, never sees real credentials, and mints
 * tokens for exactly the fixed certification identity below.
 *
 * NOT for production use. The cloud-api refuses insecure endpoint overrides outside development.
 */

const PORT = Number(process.env.DEV_IDP_PORT ?? 3340);
const HOST = "127.0.0.1";

const CERT_USER = {
  id: 867_530,
  login: "cert-user",
  name: "Certification User",
  avatar_url: "https://avatars.githubusercontent.com/u/0?v=4",
  email: null,
};

/** code -> { codeChallenge, redirectUri, clientId, exchanged } */
const issuedCodes = new Map();

const APPROVE_PAGE = (params) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Dev IdP — Authorize CodeForge</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem;background:#181a1f;border-radius:12px;border:1px solid #282c34;max-width:520px}
button{font-size:1rem;padding:.6rem 1.6rem;border-radius:8px;border:1px solid #38bdf8;background:#0ea5e9;color:#fff;cursor:pointer;margin:.4rem}
code{color:#38bdf8}</style></head>
<body><div class="card">
<h2>Development identity provider</h2>
<p>This local server doubles GitHub's OAuth endpoints for the CodeForge certification rig.</p>
<p>Application: <code>${params.get("client_id") ?? "?"}</code><br/>
Identity: <code>${CERT_USER.login}</code> (id ${CERT_USER.id})<br/>
Scope: <code>${params.get("scope") ?? "?"}</code></p>
<form method="get" action="/approve">
${[...params.entries()].map(([k, v]) => `<input type="hidden" name="${k}" value="${v}"/>`).join("\n")}
<button type="submit">Approve (cert-user)</button>
</form>
</div></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (url.pathname === "/login/oauth/authorize" && req.method === "GET") {
    const missing = ["redirect_uri", "state", "code_challenge"].filter((p) => !url.searchParams.get(p));
    if (missing.length > 0) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`Missing ${missing.join(", ")}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(APPROVE_PAGE(url.searchParams));
    return;
  }

  if (url.pathname === "/approve" && req.method === "GET") {
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "http:" || !parsed.hostname.endsWith("127.0.0.1")) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Refusing non-loopback redirect in dev IdP");
      return;
    }
    const code = crypto.randomBytes(24).toString("base64url");
    issuedCodes.set(code, {
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri,
      clientId: url.searchParams.get("client_id") ?? "",
      exchanged: false,
    });
    parsed.searchParams.set("code", code);
    parsed.searchParams.set("state", state);
    res.writeHead(302, { Location: parsed.toString() }).end();
    return;
  }

  if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      const code = body.get("code") ?? "";
      const entry = issuedCodes.get(code);
      if (!entry || entry.exchanged) {
        res.writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "bad_verification_code" }));
        return;
      }
      if (body.get("client_id") && body.get("client_id") !== entry.clientId) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "client_mismatch" }));
        return;
      }
      entry.exchanged = true;
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ access_token: `devidp_${code}`, token_type: "bearer", scope: "read:user user:email" }));
    });
    return;
  }

  if (url.pathname === "/user" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(CERT_USER));
    return;
  }

  if (url.pathname === "/user/emails" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify([{ email: "cert-user@example.com", primary: true, verified: true, visibility: "public" }]));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-idp] development identity provider on http://${HOST}:${PORT} (identity: ${CERT_USER.login})`);
});
