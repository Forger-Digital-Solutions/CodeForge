#!/usr/bin/env node
// UI walkthrough against the live installed renderer: model picker, account menu, trust popover,
// every Settings section, composer keyboard behaviour, tab order, contrast. Produces screenshots
// and a JSON report of what was observed (text on screen, console errors, unnamed controls).
//
//   CDP_PORT=9229 node scenarios/ui-walkthrough.mjs <outDir>
import fs from "node:fs";
import path from "node:path";
import { openPage, evaluate, screenshot, clickText, clickSelector, pressKey, sleep, waitFor } from "../cdp-driver.mjs";

const outDir = process.argv[2];
if (!outDir) { console.error("usage: ui-walkthrough.mjs <outDir>"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const report = { startedAt: new Date().toISOString(), steps: [] };
const cdp = await openPage();
const consoleEntries = [];
await cdp.send("Log.enable");
cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error" || p.type === "warning") consoleEntries.push({ type: p.type, text: p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300) }); });
cdp.on("Runtime.exceptionThrown", (p) => consoleEntries.push({ type: "exception", text: (p.exceptionDetails.exception?.description || p.exceptionDetails.text || "").slice(0, 300) }));
cdp.on("Log.entryAdded", (p) => { if (p.entry.level === "error" || p.entry.level === "warning") consoleEntries.push({ type: `log:${p.entry.level}`, text: p.entry.text.slice(0, 300) }); });

const text = () => evaluate(cdp, "document.body.innerText");
async function step(name, fn) {
  const entry = { name, ok: true };
  try {
    const result = await fn();
    if (result !== undefined) entry.result = result;
  } catch (e) {
    entry.ok = false;
    entry.error = e.message;
  }
  await sleep(250);
  const file = path.join(outDir, `${String(report.steps.length + 1).padStart(2, "0")}-${name}.png`);
  try { await screenshot(cdp, file); entry.screenshot = path.basename(file); } catch {}
  entry.textExcerpt = (await text().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
  report.steps.push(entry);
  console.log(`${entry.ok ? "ok " : "ERR"} ${name}${entry.error ? " — " + entry.error : ""}`);
  return entry;
}
const closeOverlays = async () => { await pressKey(cdp, "Escape", []); await sleep(150); };

await step("workspace", async () => ({ lifecycle: await evaluate(cdp, "Object.fromEntries(Array.from(document.documentElement.attributes).filter((a) => a.name.startsWith('data-cf-lifecycle-')).map((a) => [a.name, a.value]))") }));

await step("model-picker-open", async () => {
  await clickSelector(cdp, ".model-trigger");
  await sleep(400);
  const items = await evaluate(cdp, `Array.from(document.querySelectorAll('[role=option], .model-option, .model-item, .model-selector-item, li button')).map((e) => (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90)).filter(Boolean).slice(0, 60)`);
  const headings = await evaluate(cdp, `Array.from(document.querySelectorAll('.model-section-title, .model-group-title, .model-section h3, .model-section h4, [class*=section-title]')).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 30)`);
  return { items, headings };
});
await step("model-picker-filter", async () => {
  const input = await evaluate(cdp, `(() => { const i = document.querySelector('input[aria-label="Filter models or providers"]'); if (!i) return false; i.focus(); return true; })()`);
  if (!input) throw new Error("no filter input");
  await cdp.send("Input.insertText", { text: "free" });
  await sleep(300);
  return { after: (await text()).slice(0, 300) };
});
await closeOverlays();
await closeOverlays();

await step("account-menu", async () => { await clickSelector(cdp, ".cloud-account-btn"); await sleep(300); });
await closeOverlays();
await step("trust-popover", async () => { await clickSelector(cdp, ".forgezero-indicator"); await sleep(300); });
await closeOverlays();
await step("repo-intelligence-popover", async () => { await clickSelector(cdp, 'button[aria-label="Repository Intelligence"]'); await sleep(300); });
await closeOverlays();

await step("composer-typing", async () => {
  await clickSelector(cdp, ".composer-input");
  await cdp.send("Input.insertText", { text: "First line of a task" });
  await pressKey(cdp, "Enter", ["--shift"]);
  await cdp.send("Input.insertText", { text: "second line" });
  await sleep(200);
  const value = await evaluate(cdp, `document.querySelector('.composer-input').value`);
  const rows = await evaluate(cdp, `(() => { const el = document.querySelector('.composer-input'); return { rows: el.rows, height: el.getBoundingClientRect().height, scrollHeight: el.scrollHeight }; })()`);
  return { value, rows, hasNewline: value.includes("\n") };
});
await step("composer-large-paste", async () => {
  const big = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: ${"x".repeat(60)}`).join("\n");
  await cdp.send("Input.insertText", { text: "\n" + big });
  await sleep(300);
  const info = await evaluate(cdp, `(() => { const el = document.querySelector('.composer-input'); const r = el.getBoundingClientRect(); const vh = document.documentElement.clientHeight; const send = document.querySelector('.composer-send, button[aria-label="Send"], button[title="Send"]'); return { length: el.value.length, height: r.height, top: r.top, bottom: r.bottom, viewport: vh, sendVisible: send ? (send.getBoundingClientRect().bottom <= vh) : null }; })()`);
  return info;
});
await step("composer-clear", async () => {
  await evaluate(cdp, `(() => { const el = document.querySelector('.composer-input'); const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); d.set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
});

await step("keyboard-tab-order", async () => {
  await evaluate(cdp, "document.body.focus(); document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  const order = [];
  for (let i = 0; i < 30; i++) {
    await pressKey(cdp, "Tab", []);
    order.push(await evaluate(cdp, `(() => { const el = document.activeElement; if (!el || el === document.body) return 'BODY'; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || (el.innerText || el.value || '').trim()).slice(0, 40); return el.tagName + (name ? '[' + name + ']' : '') + (cs.outlineStyle !== 'none' || cs.boxShadow !== 'none' ? '' : ' {NO-FOCUS-RING}') + (r.width === 0 ? ' {INVISIBLE}' : ''); })()`));
  }
  return order;
});

await step("contrast-workspace", async () => {
  const r = await evaluate(cdp, fs.readFileSync(new URL("../contrast-audit.js", import.meta.url), "utf8"));
  return r;
});

// Settings walkthrough
await step("settings-open", async () => { await clickText(cdp, "Settings", "button"); await waitFor(cdp, `Boolean(document.querySelector('.settings-nav-item'))`, 5000, "settings nav"); });
const sections = await evaluate(cdp, `Array.from(document.querySelectorAll('.settings-nav-item')).map((e) => e.textContent.trim())`);
report.settingsSections = sections;
for (const section of sections) {
  await step(`settings-${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, async () => {
    await evaluate(cdp, `(() => { const item = Array.from(document.querySelectorAll('.settings-nav-item')).find((e) => e.textContent.trim() === ${JSON.stringify(section)}); item.click(); })()`);
    await sleep(350);
    const controls = await evaluate(cdp, `(() => { const main = document.querySelector('.settings-content, .settings-main, main') || document.body; const els = main.querySelectorAll('button, input, select, textarea, [role=switch], [role=button]'); const out = []; for (const el of els) { const r = el.getBoundingClientRect(); if (r.width === 0) continue; out.push({ tag: el.tagName, type: el.type || el.getAttribute('role') || '', label: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.placeholder || '').trim().slice(0, 50), disabled: el.disabled === true }); } return out.slice(0, 80); })()`);
    const overflow = await evaluate(cdp, `(() => { const de = document.documentElement; return { horizontal: de.scrollWidth > de.clientWidth + 1 }; })()`);
    return { controls: controls.length, disabled: controls.filter((c) => c.disabled).length, list: controls, overflow };
  });
}
await step("settings-search", async () => {
  const ok = await evaluate(cdp, `(() => { const i = document.querySelector('input[aria-label="Search settings"]'); if (!i) return false; i.focus(); return true; })()`);
  if (!ok) throw new Error("no search input");
  await cdp.send("Input.insertText", { text: "notif" });
  await sleep(300);
  return { results: await evaluate(cdp, `Array.from(document.querySelectorAll('.settings-search-result')).map((e) => e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80))`) };
});
await step("contrast-settings", async () => evaluate(cdp, fs.readFileSync(new URL("../contrast-audit.js", import.meta.url), "utf8")));
await step("settings-back", async () => { await clickSelector(cdp, ".settings-back-btn"); await sleep(300); });

report.consoleEntries = consoleEntries;
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(outDir, "ui-walkthrough.json"), JSON.stringify(report, null, 2));
console.log(`report: ${path.join(outDir, "ui-walkthrough.json")} (${consoleEntries.length} console warnings/errors)`);
cdp.close();
