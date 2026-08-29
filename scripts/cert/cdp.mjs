#!/usr/bin/env node
// Minimal Chrome DevTools Protocol driver for certifying the REAL Electron renderer.
// Uses Node's global WebSocket (Node 22+/24). Not committed as product code — a certification tool.
//
// Usage:
//   node scripts/cert/cdp.mjs eval "<jsExpression>"      → prints JSON result (awaits promises)
//   node scripts/cert/cdp.mjs screenshot <outPath>       → saves a PNG of the renderer
//   node scripts/cert/cdp.mjs reload                     → reloads the renderer and waits for load
//   node scripts/cert/cdp.mjs focus "<cssSelector>"      → focuses an element
//   node scripts/cert/cdp.mjs insertText "<text>"        → types text into the focused element (real input)
//   node scripts/cert/cdp.mjs key <Enter|Backspace|...> [--shift]  → dispatches a real key event
const PORT = process.env.CDP_PORT || 9222;

async function targetWs() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no page target");
  return page.webSocketDebuggerUrl;
}

function connect(ws) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws);
    let id = 0;
    const pending = new Map();
    sock.addEventListener("open", () => resolve(api));
    sock.addEventListener("error", (e) => reject(new Error("ws error " + (e.message || ""))));
    sock.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((r, j) => {
        const mid = ++id;
        pending.set(mid, { resolve: r, reject: j });
        sock.send(JSON.stringify({ id: mid, method, params }));
      });
    const api = { send, close: () => sock.close() };
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cdp = await connect(await targetWs());
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try {
    if (cmd === "eval") {
      const r = await cdp.send("Runtime.evaluate", { expression: args[0], returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) { console.error("EVAL_EXCEPTION:", JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)); process.exit(3); }
      console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value));
    } else if (cmd === "screenshot") {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(args[0], Buffer.from(r.data, "base64"));
      console.log("saved", args[0], fs.statSync(args[0]).size, "bytes");
    } else if (cmd === "reload") {
      await cdp.send("Page.reload", {});
      await new Promise((r) => setTimeout(r, 2500));
      console.log("reloaded");
    } else if (cmd === "focus") {
      const r = await cdp.send("Runtime.evaluate", { expression: `(()=>{const el=document.querySelector(${JSON.stringify(args[0])}); if(!el) return 'NOT_FOUND'; el.focus(); return 'FOCUSED '+(el.tagName);})()`, returnByValue: true });
      console.log(r.result.value);
    } else if (cmd === "insertText") {
      await cdp.send("Input.insertText", { text: args[0] });
      console.log("inserted");
    } else if (cmd === "key") {
      const keyName = args[0];
      const shift = args.includes("--shift");
      const map = { Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }, Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 } };
      const k = map[keyName] || { key: keyName, code: keyName, keyCode: 0 };
      const modifiers = shift ? 8 : 0;
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...k });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k });
      console.log("key", keyName, shift ? "+shift" : "");
    } else {
      console.error("unknown cmd", cmd);
      process.exit(2);
    }
  } finally {
    cdp.close();
  }
}
main().catch((e) => { console.error("CDP_ERROR:", e.message); process.exit(1); });
