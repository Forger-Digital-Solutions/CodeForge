#!/usr/bin/env node
/**
 * A real reverse proxy, run as a SEPARATE PROCESS in front of the Cloud during SSE certification.
 *
 * Two modes, deliberately:
 *
 *   streaming (default) — pipes upstream bytes straight through as they arrive, the way a correctly
 *     configured nginx/Caddy/platform edge behaves. This is the deployment shape being certified.
 *
 *   buffering (--mode buffering) — accumulates the entire upstream response and writes it in one go,
 *     the way a MISCONFIGURED edge behaves (proxy_buffering on, no X-Accel-Buffering honored). It
 *     exists as a negative control: if the certification passes against this proxy too, then the
 *     test is not actually measuring streaming and the evidence is worthless.
 *
 * Usage: node reverse-proxy.cjs --target http://127.0.0.1:PORT [--mode streaming|buffering]
 * Prints a single line "LISTENING <port>" on stdout once ready.
 */
const http = require("node:http");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = argValue("--target");
const mode = argValue("--mode", "streaming");
if (!target) {
  console.error("reverse-proxy: --target is required");
  process.exit(2);
}
const targetUrl = new URL(target);

const server = http.createServer((clientReq, clientRes) => {
  const upstreamReq = http.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: targetUrl.host },
    },
    (upstreamRes) => {
      if (mode === "buffering") {
        // Withhold everything (headers included) until upstream completes.
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          clientRes.end(Buffer.concat(chunks));
        });
        return;
      }

      // Streaming: forward headers immediately, then forward every chunk as it arrives.
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      if (typeof clientRes.flushHeaders === "function") clientRes.flushHeaders();
      upstreamRes.on("data", (chunk) => {
        clientRes.write(chunk);
      });
      upstreamRes.on("end", () => clientRes.end());
      upstreamRes.on("error", () => clientRes.destroy());
    },
  );

  upstreamReq.on("error", () => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "Bad Gateway" }));
  });

  // Propagate a client disconnect upstream — cancellation must reach the origin, not stall there.
  clientReq.on("aborted", () => upstreamReq.destroy());
  clientRes.on("close", () => {
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  });

  clientReq.pipe(upstreamReq);
});

// Never let Node's default header timeout truncate a long-lived SSE response.
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("message", (msg) => {
  if (msg === "shutdown") server.close(() => process.exit(0));
});
