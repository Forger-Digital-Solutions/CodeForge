#!/usr/bin/env node
// Deterministic network fault injection for the installed desktop app.
//
// The app's main process uses Node's fetch. With NODE_USE_ENV_PROXY=1 and HTTPS_PROXY pointing at
// this proxy, every Cloud round trip the desktop makes passes through here, so outages, black holes
// and latency can be reproduced on a normal machine without touching hosts files, firewalls or any
// other system setting — and restored by simply stopping the proxy.
//
//   node network-fault-proxy.mjs <mode> [port] [latencyMs] [--allow host1,host2]
//   modes:
//     blackhole  accept CONNECT and never answer (half-open connection: what a dead Wi-Fi link looks like)
//     refuse     reply 502 to every CONNECT immediately (DNS/route failure: cloud unreachable, fast)
//     slow       forward CONNECT after <latencyMs> and throttle the tunnel (slow network)
//     flaky      alternate between refuse and forward per connection (intermittent network)
//     forward    plain forwarding (control run)
//   --mode-file <path>   re-read the mode from <path> per connection (flip the network live)
// Prints `READY <port>` on stdout once listening. Writes one JSON line per connection to stderr.
import net from "node:net";
import http from "node:http";

import fs from "node:fs";

const [initialMode = "blackhole", portArg = "0", latencyArg = "0"] = process.argv.slice(2);
const allowIdx = process.argv.indexOf("--allow");
const allow = allowIdx > 0 ? new Set(process.argv[allowIdx + 1].split(",")) : null;
// --mode-file <path>: the mode is re-read from this file for every connection, so a test can flip
// the "network" from dead to healthy (and back) while the app keeps running — recovery without restart.
const modeFileIdx = process.argv.indexOf("--mode-file");
const modeFile = modeFileIdx > 0 ? process.argv[modeFileIdx + 1] : null;
const currentMode = () => { if (!modeFile) return initialMode; try { return fs.readFileSync(modeFile, "utf8").trim() || initialMode; } catch { return initialMode; } };
const latencyMs = Number(latencyArg) || 0;
let counter = 0;

const server = http.createServer((req, res) => {
  res.writeHead(502, { "Content-Type": "text/plain" });
  res.end("fault proxy: plain HTTP is not forwarded");
});

server.on("connect", (req, clientSocket, head) => {
  const id = ++counter;
  const mode = currentMode();
  const [host, portText] = req.url.split(":");
  const port = Number(portText || 443);
  const log = (event, extra = {}) => process.stderr.write(JSON.stringify({ id, host, port, mode, event, at: new Date().toISOString(), ...extra }) + "\n");
  log("connect");
  clientSocket.on("error", () => {});
  const effectiveMode = allow && allow.has(host) ? "forward" : mode === "flaky" ? (id % 2 === 0 ? "forward" : "refuse") : mode;
  if (effectiveMode === "blackhole") {
    // Hold the socket open forever; the client only recovers through its own timeout.
    log("blackhole-hold");
    return;
  }
  if (effectiveMode === "refuse") {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    log("refused");
    return;
  }
  const start = () => {
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      if (effectiveMode === "slow" && latencyMs > 0) {
        // Pace both directions so streaming responses arrive in visibly delayed chunks.
        const pace = (from, to) => {
          from.on("data", (chunk) => { from.pause(); setTimeout(() => { if (!to.destroyed) to.write(chunk); from.resume(); }, Math.min(latencyMs, 400)); });
          from.on("end", () => to.end());
        };
        pace(upstream, clientSocket);
        pace(clientSocket, upstream);
      } else {
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      }
      log("tunnel");
    });
    upstream.on("error", (err) => { log("upstream-error", { error: err.code || err.message }); clientSocket.destroy(); });
    clientSocket.on("close", () => upstream.destroy());
  };
  if (effectiveMode === "slow" && latencyMs > 0) setTimeout(start, latencyMs); else start();
});

server.listen(Number(portArg), "127.0.0.1", () => {
  process.stdout.write(`READY ${server.address().port}\n`);
});
process.on("SIGTERM", () => process.exit(0));
