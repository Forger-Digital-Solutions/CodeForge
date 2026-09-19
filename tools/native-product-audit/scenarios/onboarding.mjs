// Onboarding/auth/welcome-screen evidence scenario (R-UX campaign).
// Drives the REAL installed renderer via CDP — asserts structure and captures screenshots.
// Usage: node scenarios/onboarding.mjs --out <dir> --screen auth|welcome
import fs from "node:fs";
import path from "node:path";
import { openPage, evaluate, screenshot, clickSelector, waitFor, sleep } from "../cdp-driver.mjs";

const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out") + 1];
const screen = args[args.indexOf("--screen") + 1] || "auth";
fs.mkdirSync(outDir, { recursive: true });

const results = [];
async function step(name, fn) {
  const entry = { name, status: "PASS" };
  try { entry.detail = await fn(); }
  catch (e) { entry.status = "FAIL"; entry.error = String(e?.message || e); }
  results.push(entry);
  console.log(`${entry.status === "PASS" ? "PASS" : "FAIL"} ${name}${entry.error ? " — " + entry.error : ""}${entry.detail ? " " + JSON.stringify(entry.detail).slice(0, 220) : ""}`);
}

const cdp = await openPage();

async function shot(file) {
  const p = path.join(outDir, file);
  await screenshot(cdp, p);
  return path.basename(p);
}

async function viewport(w, h, label) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  await shot(`${label}-${w}x${h}.png`);
  const over = await evaluate(cdp, `(() => { const de = document.documentElement; return { h: de.scrollWidth > de.clientWidth + 1, w: de.scrollWidth, cw: de.clientWidth }; })()`);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(250);
  return over;
}

const consoleErrors = [];
{
  const { connect, pageTargetWs } = await import("../cdp-driver.mjs");
  const sock = await connect(await pageTargetWs());
  sock.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push((m.params.args?.[0]?.value ?? m.params.args?.[0]?.description ?? "console.error").slice(0, 160));
  };
}

if (screen === "auth") {
  await step("auth-screen-renders", async () => {
    await waitFor(cdp, `!!document.querySelector('.auth-card')`, 20000, "auth card");
    return evaluate(cdp, `({ title: document.querySelector('#auth-title')?.innerText, wordmark: document.querySelector('.auth-wordmark')?.innerText, free: document.querySelector('.auth-free-note')?.innerText })`);
  });
  await step("new-copy", async () => {
    const t = await evaluate(cdp, `document.querySelector('.auth-card').innerText`);
    const need = ["Your AI coding agent.", "works directly with your project", "No API key required", "18 or older", "approval settings"];
    const missing = need.filter((s) => !t.includes(s));
    if (missing.length) throw new Error("missing copy: " + missing.join(" | "));
    return { chars: t.length };
  });
  await step("github-mark-real", async () => {
    const info = await evaluate(cdp, `(() => { const btn = document.querySelector('.auth-github-button'); const svg = btn?.querySelector('svg.github-mark'); const path = svg?.querySelector('path')?.getAttribute('d') || ''; return { hasMark: !!svg, octocatPath: path.startsWith('M12 .297'), glyphGone: !btn?.querySelector('.github-glyph'), disabled: btn?.disabled }; })()`);
    if (!info.hasMark || !info.octocatPath || !info.glyphGone) throw new Error(JSON.stringify(info));
    return info;
  });
  await step("cta-gated-by-ack", async () => {
    const before = await evaluate(cdp, `document.querySelector('.auth-github-button').disabled`);
    if (!before) throw new Error("CTA enabled before acknowledgement");
    await shot("auth-01-unchecked.png");
    await clickSelector(cdp, ".auth-first-run-ack input[type=checkbox]");
    await sleep(250);
    const after = await evaluate(cdp, `document.querySelector('.auth-github-button').disabled`);
    if (after) throw new Error("CTA still disabled after acknowledgement");
    await shot("auth-02-checked.png");
    return { gated: true };
  });
  await step("auth-responsive", async () => {
    const report = {};
    for (const [w, h] of [[1600, 900], [1366, 768], [820, 720]]) {
      const over = await viewport(w, h, "auth");
      report[`${w}x${h}`] = over;
      if (over.h) throw new Error(`horizontal overflow at ${w}x${h}`);
    }
    return report;
  });
  await step("auth-tab-order", async () => {
    const order = [];
    for (let i = 0; i < 4; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
      await sleep(120);
      order.push(await evaluate(cdp, `(() => { const el = document.activeElement; const cs = el ? getComputedStyle(el) : null; return (el?.tagName || 'NONE') + ':' + (el?.getAttribute('aria-label') || el?.innerText?.slice(0, 30) || el?.type || '') + (cs && (cs.outlineStyle !== 'none' || cs.boxShadow !== 'none') ? '' : ' {no-ring}'); })()`));
    }
    return order;
  });
} else {
  await step("welcome-renders", async () => {
    await waitFor(cdp, `!!document.querySelector('.welcome-container')`, 25000, "welcome container");
    return evaluate(cdp, `({ title: document.querySelector('.welcome-title')?.innerText, sub: document.querySelector('.welcome-subtitle')?.innerText })`);
  });
  await step("welcome-copy", async () => {
    const t = await evaluate(cdp, `document.querySelector('.welcome-container').innerText`);
    const need = ["Welcome to CodeForge", "What are we building today?", "Open project folder", "Create new project", "Free AI models included", "No API key required", "Changes verified before completion"];
    const missing = need.filter((s) => !t.includes(s));
    if (missing.length) throw new Error("missing copy: " + missing.join(" | "));
    await shot("welcome-01.png");
    return { chars: t.length };
  });
  await step("recents-or-firstrun", async () => {
    const info = await evaluate(cdp, `(() => { const rows = Array.from(document.querySelectorAll('.welcome-recent-row')); return { count: rows.length, names: rows.map(r => r.querySelector('.recent-name')?.innerText?.trim()), stale: rows.filter(r => r.classList.contains('stale')).length, removes: document.querySelectorAll('.recent-remove').length, times: Array.from(document.querySelectorAll('.recent-time')).map(e => e.innerText) }; })()`);
    await shot("welcome-02-recents.png");
    return info;
  });
  await step("welcome-responsive", async () => {
    const report = {};
    for (const [w, h] of [[1920, 1080], [1366, 768], [760, 800]]) {
      const over = await viewport(w, h, "welcome");
      report[`${w}x${h}`] = over;
      if (over.h) throw new Error(`horizontal overflow at ${w}x${h}`);
    }
    return report;
  });
}

await step("no-console-errors", async () => {
  const real = consoleErrors.filter((e) => !/favicon|Autofill/.test(e));
  if (real.length) throw new Error(real.join(" | "));
  return { errors: 0 };
});

fs.writeFileSync(path.join(outDir, "onboarding-results.json"), JSON.stringify({ screen, results }, null, 2));
const fails = results.filter((r) => r.status === "FAIL").length;
console.log(`\nVERDICT ${fails === 0 ? "PASS" : "FAIL"} — ${results.length - fails} pass / ${fails} fail`);
process.exit(fails === 0 ? 0 : 1);
