#!/usr/bin/env node
/**
 * Public documentation link validation (Security R1, Phase 57 "legal-doc link validation").
 *
 * Every relative Markdown link in the public security/privacy/legal documentation tree, the
 * README, and SECURITY.md must resolve to a file in the repository (optionally with a #fragment).
 * External links are recorded, not fetched (no network in CI). Fails on the first dangling link.
 *
 *   node scripts/security/validate-doc-links.mjs [--json docs/evidence/security-r1/doc-links.json]
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "docs/evidence/security-r1/doc-links.json";

const ROOTS = ["README.md", "SECURITY.md", "docs/security", "docs/privacy", "docs/legal/pass3/proposed-drafts", "docs/legal/subprocessor-list.md", "docs/legal/data-processing-addendum-draft.md", "docs/legal/ai-and-third-party-model-disclosure.md", "docs/legal/OWNER-LEGAL-INPUTS.md", "docs/legal/privacy-rights-workflow.md", "docs/certification", "docs/FAQ.md", "docs/ABOUT.md"];

async function collect(target) {
  const abs = path.resolve(root, target);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return abs.endsWith(".md") ? [abs] : [];
  const out = [];
  for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
    if (entry.name === "evidence" || entry.name.startsWith(".")) continue;
    out.push(...(await collect(path.join(target, entry.name))));
  }
  return out;
}

const files = (await Promise.all(ROOTS.map(collect))).flat();
const broken = [];
let checked = 0;
let external = 0;
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const file of files) {
  const content = await fs.readFile(file, "utf8");
  let m;
  while ((m = LINK.exec(content)) !== null) {
    const target = m[1];
    if (/^(https?:|mailto:|tel:)/i.test(target)) {
      external++;
      continue;
    }
    if (target.startsWith("#")) continue;
    checked++;
    const [rel] = target.split("#");
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(rel));
    try {
      await fs.access(resolved);
    } catch {
      broken.push({ file: path.relative(root, file).replace(/\\/g, "/"), target, line: content.slice(0, m.index).split("\n").length });
    }
  }
}

const result = { generatedAt: new Date().toISOString(), filesScanned: files.length, relativeLinksChecked: checked, externalLinks: external, broken, status: broken.length === 0 ? "PASS" : "FAIL" };
await fs.mkdir(path.dirname(path.resolve(root, jsonOut)), { recursive: true });
await fs.writeFile(path.resolve(root, jsonOut), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: result.status, filesScanned: files.length, relativeLinksChecked: checked, externalLinks: external, broken: broken.length, report: jsonOut }, null, 2));
for (const b of broken) console.log(`  BROKEN ${b.file}:${b.line} -> ${b.target}`);
if (broken.length > 0) process.exitCode = 2;
