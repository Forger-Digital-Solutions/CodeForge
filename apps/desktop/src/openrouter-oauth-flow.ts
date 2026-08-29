import http from "node:http";
import { AddressInfo } from "node:net";
import { shell } from "electron";
import { OpenRouterOAuth } from "@codeforge/providers";

/**
 * Runs the OpenRouter OAuth PKCE flow from the Electron main process:
 *   1. generate PKCE verifier/challenge + random state
 *   2. start a loopback (127.0.0.1) callback server on an ephemeral port
 *   3. open the SYSTEM browser to the authorization URL
 *   4. on redirect, validate state and read the authorization code
 *   5. exchange code + verifier for a user-controlled API key
 *
 * Security: state is validated (CSRF), the verifier is single-use, the server binds only to
 * loopback, and neither the code, verifier, nor key is ever logged. The returned key is handed
 * straight to the caller for encrypted storage.
 */
export interface OpenRouterOAuthOptions {
  timeoutMs?: number;
  /** Injectable opener/exchanger for tests (defaults to shell.openExternal + real exchange). */
  openExternal?: (url: string) => Promise<void>;
  exchange?: typeof OpenRouterOAuth.exchangeCodeForKey;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>CodeForge</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center}.d{color:#7c9cff;font-size:40px}</style></head>
<body><div class="card"><div class="d">◈</div><h2>OpenRouter connected</h2>
<p>You can close this tab and return to CodeForge.</p></div></body></html>`;

export function runOpenRouterOAuth(opts: OpenRouterOAuthOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const openExternal = opts.openExternal ?? ((url: string) => shell.openExternal(url));
  const exchange = opts.exchange ?? OpenRouterOAuth.exchangeCodeForKey;

  return new Promise<string>((resolve, reject) => {
    void (async () => {
      const pkce = await OpenRouterOAuth.generatePkcePair();
      const state = OpenRouterOAuth.generateState();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
          if (reqUrl.pathname !== "/callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          // Validates state (throws on mismatch) and extracts the code.
          const code = OpenRouterOAuth.parseCallback(`http://127.0.0.1${req.url}`, state);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(SUCCESS_HTML);
          finish(async () => exchange({ code, codeVerifier: pkce.codeVerifier }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Authorization failed. You can close this tab.");
          finishReject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          server.close();
        } catch {
          // ignore
        }
      };
      const finish = (getKey: () => Promise<string>) => {
        if (settled) return;
        settled = true;
        getKey()
          .then((key) => {
            cleanup();
            resolve(key);
          })
          .catch((e) => {
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      };
      const finishReject = (e: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };

      server.on("error", (e) => finishReject(e instanceof Error ? e : new Error(String(e))));

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        const callbackUrl = `http://127.0.0.1:${addr.port}/callback`;
        const authUrl = OpenRouterOAuth.buildAuthUrl({ callbackUrl, codeChallenge: pkce.codeChallenge, state });
        timer = setTimeout(() => finishReject(new Error("OpenRouter authorization timed out")), timeoutMs);
        openExternal(authUrl).catch((e) => finishReject(e instanceof Error ? e : new Error(String(e))));
      });
    })().catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}
