import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parsePuterAuthorization, type PuterAuthorization } from "./puter-account-types.js";

export interface PuterAccountFlowOptions {
  openExternal: (url: string) => Promise<void>;
  timeoutMs?: number;
}

function page(nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CodeForge · Puter</title>
<style>body{font:16px system-ui;background:#111;color:#eee;max-width:640px;margin:80px auto;padding:24px}button{padding:12px;border:1px solid #888;background:#222;color:white}</style></head>
<body><h1>Connect Puter account</h1><p>View your allowance and available models. Puter inference stays blocked in ForgeAuto/Free because purchased credits can be consumed after the allowance.</p>
<button id="connect">Sign in to Puter</button><p id="status" role="status"></p>
<script src="https://js.puter.com/v2/"></script><script nonce="${nonce}">
document.getElementById('connect').onclick = async () => {
  const status = document.getElementById('status');
  try {
    const signed = await puter.auth.signIn({ request_auth: true, attempt_temp_user_creation: false });
    if (!signed.success || !signed.token) throw new Error('Authorization did not complete');
    const user = await puter.auth.getUser();
    const models = await puter.ai.listModels();
    const usage = await puter.auth.getMonthlyUsage();
    const response = await fetch('/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodeForge-Nonce': '${nonce}' }, body: JSON.stringify({ token: signed.token, accountId: user.uuid || user.username, catalogModels: models.length, monthlyAllowanceMicrocents: usage.allowanceInfo?.monthUsageAllowance, remainingMicrocents: usage.allowanceInfo?.remaining }) });
    if (!response.ok) throw new Error('CodeForge could not save this connection');
    puter.auth.signOut();
    status.textContent = 'Account observed. Free inference remains blocked. You can close this tab.';
    document.getElementById('connect').disabled = true;
  } catch { status.textContent = 'Connection did not complete. Try again or return to CodeForge.'; }
};</script></body></html>`;
}

let pending = false;

export async function runPuterAccountFlow(options: PuterAccountFlowOptions): Promise<PuterAuthorization> {
  if (pending) throw new Error("Puter authorization is already in progress");
  pending = true;
  try {
    return await new Promise<PuterAuthorization>((resolve, reject) => {
      const nonce = randomBytes(32).toString("hex");
      let settled = false;
      const finish = (error?: Error, result?: PuterAuthorization) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections();
        if (error) reject(error); else resolve(result!);
      };
      const server = http.createServer(async (req, res) => {
        const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== authority || settled) { res.writeHead(400); res.end(); return; }
        if (req.method === "GET" && req.url === `/connect/${nonce}`) {
          res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}' https://js.puter.com; style-src 'unsafe-inline'; connect-src 'self' https://api.puter.com; frame-src https://puter.com https://*.puter.com; img-src https://puter.com https://*.puter.com data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page(nonce)); return;
        }
        if (req.method !== "POST" || req.url !== "/callback" || req.headers.origin !== `http://${authority}` || req.headers["x-codeforge-nonce"] !== nonce || req.headers["content-type"] !== "application/json") {
          res.writeHead(403); res.end(); return;
        }
        let body = "";
        try {
          for await (const chunk of req) {
            body += String(chunk);
            if (Buffer.byteLength(body) > 16_384) { res.writeHead(413); res.end(); req.destroy(); return; }
          }
          const result = parsePuterAuthorization(JSON.parse(body));
          res.writeHead(200); res.end("Account received"); finish(undefined, result);
        } catch { res.writeHead(400); res.end("Invalid authorization"); }
      });
      const timer = setTimeout(() => finish(new Error("Puter authorization timed out")), options.timeoutMs ?? 180_000);
      server.on("error", () => finish(new Error("Puter authorization listener failed")));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        void options.openExternal(`http://127.0.0.1:${address.port}/connect/${nonce}`).catch(() => finish(new Error("Could not open Puter authorization")));
      });
    });
  } finally { pending = false; }
}
