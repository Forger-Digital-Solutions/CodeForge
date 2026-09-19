#!/usr/bin/env node
// Chrome DevTools Protocol driver for the REAL CodeForge renderer (R16 lifecycle harness).
//
// Drives the installed Electron app through --remote-debugging-port. Certification tooling only:
// it observes and interacts with the real renderer, it never injects product state.
//
// Usage: CDP_PORT=9229 node cdp-driver.mjs <command> [args]
//   eval "<js>"                      evaluate (awaits promises) → JSON
//   text                             document.body.innerText
//   html [selector]                  outerHTML of selector (default: body), truncated
//   screenshot <out.png>             PNG of the renderer viewport
//   lifecycle                        renderer startup marks (data-cf-lifecycle-*) + navigation timing
//   wait-text "<substr>" [ms]        wait until body text contains substring
//   wait-selector "<css>" [ms]       wait until selector exists
//   wait-gone "<css>" [ms]           wait until selector no longer exists
//   click "<css>" [index]            real mouse click at the element's centre
//   click-text "<text>" [tag]        click the first element whose trimmed text equals <text>
//   focus "<css>"                    focus an element
//   type "<text>"                    insert text into the focused element (real input events)
//   key <Key> [--shift] [--ctrl] [--alt]   dispatch a real key press
//   metrics                          Performance.getMetrics (JS heap, DOM nodes, layout/style counts)
//   processes                        SystemInfo.getProcessInfo (per Chromium process CPU time)
//   console <ms>                     collect console + exceptions for <ms>
//   (window state/bounds are driven natively by the PowerShell module — Electron's browser target
//    does not implement Browser.getWindowForTarget/setWindowBounds)
//   overflow                         horizontal/vertical overflow + elements outside the viewport
//   a11y                             accessibility audit: controls without names, focus order
//   tab-order [n]                    press Tab n times and report the focused element each time
//   offline <on|off>                 Network.emulateNetworkConditions for the renderer
//   throttle <latencyMs> <kbps>      slow-network emulation for the renderer
//   scale <factor>                   Emulation.setDeviceMetricsOverride deviceScaleFactor (0 = reset)
//   reload                           reload the document and wait for load
//   contrast                         computed foreground/background contrast of visible text nodes below 4.5:1
import fs from "node:fs";

const HOST = process.env.CDP_HOST || "127.0.0.1";
const PORT = Number(process.env.CDP_PORT || 9229);

export async function listTargets() {
  const res = await fetch(`http://${HOST}:${PORT}/json`, { signal: AbortSignal.timeout(5_000) });
  return res.json();
}

export async function pageTargetWs() {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/.test(t.url));
  if (!page) throw new Error("no page target");
  return page.webSocketDebuggerUrl;
}

export async function browserTargetWs() {
  const res = await fetch(`http://${HOST}:${PORT}/json/version`, { signal: AbortSignal.timeout(5_000) });
  const v = await res.json();
  return v.webSocketDebuggerUrl;
}

export function connect(ws) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    sock.addEventListener("open", () => resolve(api));
    sock.addEventListener("error", (e) => reject(new Error("ws error " + (e.message || ""))));
    sock.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) fn(msg.params);
      }
    });
    const send = (method, params = {}) =>
      new Promise((r, j) => {
        const mid = ++id;
        pending.set(mid, { resolve: r, reject: j });
        sock.send(JSON.stringify({ id: mid, method, params }));
      });
    const on = (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    };
    const api = { send, on, close: () => sock.close() };
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error("EVAL_EXCEPTION: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text || r.exceptionDetails));
  }
  return r.result.value;
}

export async function elementCenter(cdp, selector, index = 0) {
  const rect = await evaluate(cdp, `(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    const el = els[${index}];
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName, text: (el.innerText || el.value || "").slice(0, 80) };
  })()`);
  if (!rect) throw new Error(`element not found: ${selector}[${index}]`);
  if (rect.w === 0 || rect.h === 0) throw new Error(`element has no box: ${selector}[${index}]`);
  return rect;
}

export async function mouseClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

export async function pressKey(cdp, name, flags) {
  const base = KEYS[name] || (name.length === 1 ? { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name } : { key: name, code: name, windowsVirtualKeyCode: 0 });
  let modifiers = 0;
  if (flags.includes("--alt")) modifiers |= 1;
  if (flags.includes("--ctrl")) modifiers |= 2;
  if (flags.includes("--shift")) modifiers |= 8;
  const down = { type: base.text && modifiers === 0 ? "keyDown" : "rawKeyDown", modifiers, ...base };
  if (down.type === "rawKeyDown") delete down.text;
  await cdp.send("Input.dispatchKeyEvent", down);
  if (base.text && modifiers === 0) await cdp.send("Input.dispatchKeyEvent", { type: "char", modifiers, text: base.text, key: base.key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode });
}

export const focusedDescriptor = `(() => {
  const el = document.activeElement;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { tag: el.tagName, id: el.id || null, cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || null,
    role: el.getAttribute("role"), label: el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || el.value || "").trim().slice(0, 60),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden", outline: cs.outlineStyle + " " + cs.outlineWidth, boxShadow: cs.boxShadow !== "none" };
})()`;

export async function waitFor(cdp, predicateExpr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, predicateExpr)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v));

  if (cmd === "processes") {
    const cdp = await connect(await browserTargetWs());
    try {
      const r = await cdp.send("SystemInfo.getProcessInfo");
      out(r.processInfo);
    } finally { cdp.close(); }
    return;
  }
  const cdp = await connect(await pageTargetWs());
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  try {
    switch (cmd) {
      case "eval": out(await evaluate(cdp, args[0])); break;
      case "text": out(await evaluate(cdp, "document.body.innerText")); break;
      case "html": out(String(await evaluate(cdp, `(document.querySelector(${JSON.stringify(args[0] || "body")}) || {}).outerHTML || ""`)).slice(0, Number(args[1] || 20000))); break;
      case "screenshot": {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(args[0], Buffer.from(r.data, "base64"));
        out({ saved: args[0], bytes: fs.statSync(args[0]).size });
        break;
      }
      case "lifecycle": {
        out(await evaluate(cdp, `(() => {
          const marks = Object.fromEntries(Array.from(document.documentElement.attributes).filter((a) => a.name.startsWith("data-cf-lifecycle-")).map((a) => [a.name.slice("data-cf-lifecycle-".length), Number(a.value)]));
          const nav = performance.getEntriesByType("navigation")[0];
          return { timeOrigin: performance.timeOrigin, marks, relativeMs: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v - performance.timeOrigin)])), navigation: nav ? { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), loadEvent: Math.round(nav.loadEventEnd) } : null, readyState: document.readyState, title: document.title, url: location.href };
        })()`));
        break;
      }
      case "wait-text": await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(args[0])})`, Number(args[1] || 15000), `text "${args[0]}"`); out("ok"); break;
      case "wait-selector": await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(args[0])}))`, Number(args[1] || 15000), `selector ${args[0]}`); out("ok"); break;
      case "wait-gone": await waitFor(cdp, `!document.querySelector(${JSON.stringify(args[0])})`, Number(args[1] || 15000), `absence of ${args[0]}`); out("ok"); break;
      case "click": {
        const c = await elementCenter(cdp, args[0], Number(args[1] || 0));
        await mouseClick(cdp, c.x, c.y);
        out({ clicked: args[0], at: [Math.round(c.x), Math.round(c.y)], tag: c.tag, text: c.text });
        break;
      }
      case "click-text": {
        const tag = args[1] || "button";
        const rect = await evaluate(cdp, `(() => {
          const t = ${JSON.stringify(args[0])};
          const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((e) => (e.innerText || e.textContent || "").trim() === t);
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        })()`);
        if (!rect) throw new Error(`no ${tag} with text "${args[0]}"`);
        await mouseClick(cdp, rect.x, rect.y);
        out({ clicked: args[0], at: [Math.round(rect.x), Math.round(rect.y)] });
        break;
      }
      case "focus": out(await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return "NOT_FOUND"; el.focus(); return "FOCUSED " + el.tagName; })()`)); break;
      case "type": await cdp.send("Input.insertText", { text: args[0] }); out("ok"); break;
      case "key": await pressKey(cdp, args[0], args.slice(1)); out({ key: args[0], focused: await evaluate(cdp, focusedDescriptor) }); break;
      case "metrics": {
        await cdp.send("Performance.enable");
        const m = await cdp.send("Performance.getMetrics");
        out(Object.fromEntries(m.metrics.map((x) => [x.name, x.value])));
        break;
      }
      case "console": {
        const ms = Number(args[0] || 3000);
        const entries = [];
        await cdp.send("Log.enable");
        cdp.on("Runtime.consoleAPICalled", (p) => entries.push({ type: p.type, text: p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300) }));
        cdp.on("Runtime.exceptionThrown", (p) => entries.push({ type: "exception", text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text || "").slice(0, 300) }));
        cdp.on("Log.entryAdded", (p) => entries.push({ type: `log:${p.entry.level}`, source: p.entry.source, text: p.entry.text.slice(0, 300), url: p.entry.url }));
        await sleep(ms);
        out(entries);
        break;
      }
      case "overflow": {
        out(await evaluate(cdp, `(() => {
          const de = document.documentElement;
          const vw = de.clientWidth, vh = de.clientHeight;
          const offscreen = [];
          // A control below the fold of its own scrollable list is reachable by scrolling; only
          // controls outside the viewport with no scrollable ancestor are genuinely unreachable.
          const inScrollable = (el) => { let e = el.parentElement; while (e && e !== document.body) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return true; e = e.parentElement; } return false; };
          for (const el of document.querySelectorAll("button, input, textarea, select, [role=button], a")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if ((r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) && !inScrollable(el)) offscreen.push({ tag: el.tagName, text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
          }
          return { viewport: [vw, vh], scroll: [de.scrollWidth, de.scrollHeight], horizontalOverflow: de.scrollWidth > vw + 1, verticalOverflow: de.scrollHeight > vh + 1, offscreenControls: offscreen.slice(0, 40), offscreenCount: offscreen.length };
        })()`));
        break;
      }
      case "a11y": {
        out(await evaluate(cdp, `(() => {
          const unnamed = [];
          const tiny = [];
          const controls = document.querySelectorAll("button, [role=button], input, textarea, select, a[href]");
          for (const el of controls) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.textContent || "").trim();
            if (!name) unnamed.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
            if ((r.width < 24 || r.height < 24) && el.tagName !== "INPUT") tiny.push({ tag: el.tagName, name: name.slice(0, 40), size: [Math.round(r.width), Math.round(r.height)] });
          }
          const imgs = Array.from(document.querySelectorAll("img")).filter((i) => !i.hasAttribute("alt")).length;
          const landmarks = Array.from(document.querySelectorAll("main, nav, header, aside, [role=main], [role=navigation]")).map((e) => e.tagName + (e.getAttribute("aria-label") ? "[" + e.getAttribute("aria-label") + "]" : ""));
          return { controls: controls.length, unnamedControls: unnamed.slice(0, 40), unnamedCount: unnamed.length, smallTargets: tiny.slice(0, 40), smallTargetCount: tiny.length, imagesWithoutAlt: imgs, landmarks, lang: document.documentElement.lang || null, title: document.title };
        })()`));
        break;
      }
      case "tab-order": {
        const n = Number(args[0] || 25);
        const order = [];
        for (let i = 0; i < n; i++) {
          await pressKey(cdp, "Tab", []);
          order.push(await evaluate(cdp, focusedDescriptor));
        }
        out(order);
        break;
      }
      case "offline": {
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: args[0] === "on", latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        out({ offline: args[0] === "on" });
        break;
      }
      case "throttle": {
        await cdp.send("Network.enable");
        const kbps = Number(args[1] || 0);
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: Number(args[0] || 0), downloadThroughput: kbps > 0 ? (kbps * 1024) / 8 : -1, uploadThroughput: kbps > 0 ? (kbps * 1024) / 8 : -1 });
        out({ latencyMs: Number(args[0] || 0), kbps });
        break;
      }
      case "scale": {
        const f = Number(args[0]);
        if (!f) await cdp.send("Emulation.clearDeviceMetricsOverride");
        else await cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: f, mobile: false });
        out({ scale: f || "reset" });
        break;
      }
      case "reload": {
        await cdp.send("Page.reload", {});
        await sleep(2500);
        out("reloaded");
        break;
      }
      case "contrast": {
        out(await evaluate(cdp, `(() => {
          const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(",").map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
          const bgOf = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return c.rgb; e = e.parentElement; } return [15, 16, 18]; };
          const low = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n; let checked = 0;
          while ((n = walker.nextNode()) && checked < 4000) {
            const t = n.textContent.trim(); if (!t || t.length < 2) continue;
            const el = n.parentElement; if (!el) continue;
            const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.opacity === "0") continue;
            const fg = parse(cs.color); if (!fg) continue;
            checked++;
            const bg = bgOf(el);
            const l1 = lum(fg.rgb), l2 = lum(bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
            const threshold = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
            if (ratio < threshold) low.push({ text: t.slice(0, 40), ratio: Math.round(ratio * 100) / 100, fontSize: size, color: cs.color, bg: "rgb(" + bg.join(",") + ")", cls: String(el.className).slice(0, 50) });
          }
          low.sort((a, b) => a.ratio - b.ratio);
          return { checked, lowContrastCount: low.length, lowest: low.slice(0, 40) };
        })()`));
        break;
      }
      default:
        console.error("unknown command", cmd);
        process.exit(2);
    }
  } finally {
    cdp.close();
  }
}

export async function openPage() {
  const cdp = await connect(await pageTargetWs());
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return cdp;
}

export async function screenshot(cdp, outPath) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(outPath, Buffer.from(r.data, "base64"));
  return fs.statSync(outPath).size;
}

export async function clickText(cdp, text, tag = "button", exact = true) {
  const rect = await evaluate(cdp, `(() => {
    const t = ${JSON.stringify(text)};
    const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)})).find((e) => { const s = (e.innerText || e.textContent || "").trim(); return ${exact ? "s === t" : "s.includes(t)"}; });
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect) throw new Error(`no ${tag} with text "${text}"`);
  await mouseClick(cdp, rect.x, rect.y);
  return rect;
}

export async function clickSelector(cdp, selector, index = 0) {
  const c = await elementCenter(cdp, selector, index);
  await mouseClick(cdp, c.x, c.y);
  return c;
}

import { pathToFileURL } from "node:url";
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("CDP_ERROR:", e.message);
    process.exit(1);
  });
}
