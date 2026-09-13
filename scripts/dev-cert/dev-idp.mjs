import http from "node:http";
import crypto from "node:crypto";

/**
 * Local development identity-provider double for GitHub OAuth (zero-setup R1 certification rig).
 *
 * This exists because a dev machine has no registered CodeForge GitHub OAuth App. It doubles ONLY
 * github.com's four OAuth/profile endpoints so the entire CodeForge-side flow — desktop PKCE,
 * cloud transaction store, token exchange, profile fetch, JWT minting, entitlement, ledger — runs
 * as real production code. It never touches github.com, never sees real credentials, and mints
 * tokens for exactly the two fixed certification identities below.
 *
 * NOT for production use. The cloud-api refuses insecure endpoint overrides outside development.
 */

const PORT = Number(process.env.DEV_IDP_PORT ?? 3340);
const HOST = "127.0.0.1";

const CERT_USERS = {
  "cert-user-a": {
    id: 867_530,
    login: "cert-user-a",
    name: "Certification User A",
    avatar_url: "https://avatars.githubusercontent.com/u/0?v=4",
    email: null,
  },
  "cert-user-b": {
    id: 867_531,
    login: "cert-user-b",
    name: "Certification User B",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    email: null,
  },
};

/** code -> { codeChallenge, redirectUri, clientId, identity, exchanged } */
const issuedCodes = new Map();

function certificationIdentity(identity) {
  return CERT_USERS[identity] ?? null;
}

function approvalUrl(params, identity) {
  const url = new URL("/approve", `http://${HOST}:${PORT}`);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  url.searchParams.set("identity", identity);
  return url.pathname + url.search;
}

function identityForBearer(req) {
  const token = req.headers.authorization?.match(/^Bearer devidp_(.+)$/)?.[1];
  return token ? certificationIdentity(issuedCodes.get(token)?.identity) : null;
}

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
Scope: <code>${params.get("scope") ?? "?"}</code></p>
<p>Choose the fixed local identity to certify account and usage isolation.</p>
${Object.values(CERT_USERS).map((user) => `<a href="${approvalUrl(params, user.login)}"><button type="button">Approve (${user.login})</button></a>`).join("\n")}
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
    const identity = certificationIdentity(url.searchParams.get("identity"));
    if (!identity) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Refusing unknown development identity");
      return;
    }
    const code = crypto.randomBytes(24).toString("base64url");
    issuedCodes.set(code, {
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri,
      clientId: url.searchParams.get("client_id") ?? "",
      identity: identity.login,
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
      let body;
      try {
        body = req.headers["content-type"]?.includes("application/json")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      const code = typeof body.code === "string" ? body.code : "";
      const entry = issuedCodes.get(code);
      if (!entry || entry.exchanged) {
        res.writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "bad_verification_code" }));
        return;
      }
      if (typeof body.client_id === "string" && body.client_id !== entry.clientId) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "client_mismatch" }));
        return;
      }
      const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || challenge !== entry.codeChallenge) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      entry.exchanged = true;
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ access_token: `devidp_${code}`, token_type: "bearer", scope: "read:user user:email" }));
    });
    return;
  }

  if (url.pathname === "/user" && req.method === "GET") {
    const identity = identityForBearer(req);
    if (!identity) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
    return;
  }

  if (url.pathname === "/user/emails" && req.method === "GET") {
    const identity = identityForBearer(req);
    if (!identity) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify([{ email: `${identity.login}@example.com`, primary: true, verified: true, visibility: "public" }]));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-idp] development identity provider on http://${HOST}:${PORT} (identities: ${Object.keys(CERT_USERS).join(", ")})`);
});
