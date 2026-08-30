import http from "node:http";
import type { AddressInfo } from "node:net";
import { shell } from "electron";

export interface CodeForgeCloudAuthOptions {
  cloudApiUrl?: string;
  timeoutMs?: number;
  openExternal?: (url: string) => Promise<void>;
  fetchFn?: typeof fetch;
}

export interface CloudAuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    displayName: string;
    avatarUrl?: string;
    primaryIdentity: string;
  };
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>CodeForge Cloud</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem;background:#181a1f;border-radius:12px;border:1px solid #282c34;box-shadow:0 8px 24px rgba(0,0,0,0.5)}.d{color:#38bdf8;font-size:48px;margin-bottom:12px}
h2{margin:0 0 8px 0;font-size:24px}p{color:#9ca3af;margin:0}</style></head>
<body><div class="card"><div class="d">✦</div><h2>CodeForge Connected</h2>
<p>You can close this tab and return to the CodeForge app.</p></div></body></html>`;

export function runCodeForgeCloudAuth(opts: CodeForgeCloudAuthOptions = {}): Promise<CloudAuthResult> {
  const cloudApiUrl = (opts.cloudApiUrl ?? "http://127.0.0.1:3220").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 180000;
  const openExternal = opts.openExternal ?? ((url: string) => shell.openExternal(url));
  const fetchFn = opts.fetchFn ?? fetch;

  return new Promise<CloudAuthResult>((resolve, reject) => {
    void (async () => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let server: http.Server | null = null;
      let startData: { state: string; codeVerifier: string; codeChallenge: string; authUrl: string } | null = null;
      let redirectUri = "";

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (server) {
          try {
            server.close();
          } catch {}
        }
      };

      const finish = (result: CloudAuthResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      timer = setTimeout(() => {
        finishReject(new Error("CodeForge Cloud authentication timed out"));
      }, timeoutMs);

      server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
          if (reqUrl.pathname !== "/auth/callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          if (!startData) {
            throw new Error("Authentication flow was not properly initiated");
          }

          const code = reqUrl.searchParams.get("code") || "";
          const state = reqUrl.searchParams.get("state") || "";

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(SUCCESS_HTML);

          // Exchange authorization code for tokens
          const exchangeRes = await fetchFn(`${cloudApiUrl}/v1/auth/exchange`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              state,
              codeVerifier: startData.codeVerifier,
              redirectUri,
            }),
          });

          if (!exchangeRes.ok) {
            const errText = await exchangeRes.text();
            throw new Error(`Cloud exchange failed: ${errText}`);
          }

          const authTokens = (await exchangeRes.json()) as CloudAuthResult;
          finish(authTokens);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Authentication error. Please return to CodeForge.");
          finishReject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      server.listen(0, "127.0.0.1", async () => {
        try {
          const addr = server!.address() as AddressInfo;
          redirectUri = `http://127.0.0.1:${addr.port}/auth/callback`;

          const startRes = await fetchFn(`${cloudApiUrl}/v1/auth/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ redirectUri }),
          });

          if (!startRes.ok) {
            throw new Error(`Failed to initiate Cloud auth: HTTP ${startRes.status}`);
          }

          startData = (await startRes.json()) as {
            state: string;
            codeVerifier: string;
            codeChallenge: string;
            authUrl: string;
          };

          await openExternal(startData.authUrl);
        } catch (err) {
          finishReject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    })();
  });
}
