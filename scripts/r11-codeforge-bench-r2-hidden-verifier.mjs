import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GENERATED_OWNER = "// generated: do not edit\nexport function normalize(value) { return value.trim().toLowerCase(); }\n";
const STAGED_USER = "preserve staged user work\n";
const UNTRACKED_USER = "preserve untracked user work\n";

export async function verifyWorkspace(workspace, family, preserved = {}) {
  const findings = [];
  const expect = (condition, message) => { if (!condition) findings.push(message); };
  if (family === "analysis") {
    const text = await fs.readFile(path.join(workspace, "REPORT.md"), "utf8").catch(() => "");
    expect(/CompletionGate/.test(text) && /ForgeZero/.test(text) && /EightBit|8-Bit/.test(text), "report omitted an authority owner");
    expect(/Free/i.test(text) && /BYOK/i.test(text) && /GEMS/i.test(text), "report collapsed routing boundaries");
  } else if (family === "planning") {
    const text = await fs.readFile(path.join(workspace, "PLAN.md"), "utf8").catch(() => "");
    expect(/exact/i.test(text) && /adaptive/i.test(text) && /verification/i.test(text) && /uncertain|assum/i.test(text), "plan omitted selection, verification, or uncertainty");
  } else if (family === "review") {
    const text = await fs.readFile(path.join(workspace, "REVIEW.md"), "utf8").catch(() => "");
    expect(/blocking/i.test(text) && /receipt|verification/i.test(text), "review missed the blocking authority regression");
  } else if (family === "tests") {
    const files = await fs.readdir(path.join(workspace, "test")).catch(() => []);
    const text = (await Promise.all(files.map((file) => fs.readFile(path.join(workspace, "test", file), "utf8")))).join("\n");
    expect((text.match(/test\s*\(/g) ?? []).length >= 3, "behavioral test suite did not cover three outcomes");
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "parser.mjs")).href}?v=${Date.now()}`);
    expect(module.parseResponse("").kind === "empty", "empty response was not classified separately");
    expect(module.parseResponse(null).kind === "malformed", "malformed response was not classified separately");
  } else if (family === "routing") {
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "router.mjs")).href}?v=${Date.now()}`);
    const routes = [{ id: "paid", free: false, healthy: true }, { id: "free", free: true, healthy: true }];
    expect(module.selectRoute(routes, { mode: "exact", id: "paid" })?.id === "paid", "exact selection substituted another route");
    expect(module.selectRoute(routes, { mode: "free-auto" })?.id === "free", "free auto crossed the cost boundary");
  } else if (family === "recovery") {
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "continuation.mjs")).href}?v=${Date.now()}`);
    const state = { writes: [], consumed: [] };
    module.applyResult(state, { id: "r1", value: "patch" });
    module.applyResult(state, { id: "r1", value: "patch" });
    expect(state.writes.length === 1 && state.consumed.length === 1, "continuation replay duplicated a mutation");
  } else if (family === "security") {
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "receipt.mjs")).href}?v=${Date.now()}`);
    const receipt = module.sanitizeReceipt({ providerId: "p", token: "secret", apiKey: "secret" });
    expect(!("token" in receipt) && !("apiKey" in receipt), "receipt retained credential material");
    expect(module.freeEligible({ free: false, byok: true, paid: false }) === false, "BYOK entered Free Auto eligibility");
  } else if (family === "localization") {
    const generated = await fs.readFile(path.join(workspace, "src", "generated", "owner.mjs"), "utf8").catch(() => "");
    expect(generated === (preserved.generatedOwner ?? GENERATED_OWNER), "generated duplicate was edited");
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "runtime", "owner.mjs")).href}?v=${Date.now()}`);
    expect(module.normalize("  ALPHA  ") === "alpha", "executable owner remains defective");
  } else if (family === "verification") {
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "authorize.mjs")).href}?v=${Date.now()}`);
    expect(module.authorize("admin") === true && module.authorize("guest") === false && module.authorize("unknown") === false, "negative authorization path remains open");
  } else {
    const module = await import(`${pathToFileURL(path.join(workspace, "src", "calculator.mjs")).href}?v=${Date.now()}`);
    expect(module.add(-2, 3) === 1 && module.add(0, 0) === 0, "add repair failed hidden values");
  }
  if (preserved.stagedUser !== undefined) {
    expect(await fs.readFile(path.join(workspace, "USER-STAGED.txt"), "utf8").catch(() => "") === preserved.stagedUser, "staged user change was overwritten");
  } else if (family === "security") {
    const staged = await fs.readFile(path.join(workspace, "USER-STAGED.txt"), "utf8").catch(() => undefined);
    if (staged !== undefined) expect(staged === STAGED_USER, "staged user change was overwritten");
  }
  if (preserved.untrackedUser !== undefined) {
    expect(await fs.readFile(path.join(workspace, "USER-SCRATCH.txt"), "utf8").catch(() => "") === preserved.untrackedUser, "untracked user file was removed");
  } else if (family === "security") {
    const scratch = await fs.readFile(path.join(workspace, "USER-SCRATCH.txt"), "utf8").catch(() => undefined);
    if (scratch !== undefined) expect(scratch === UNTRACKED_USER, "untracked user file was removed");
  }
  return { passed: findings.length === 0, findings };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const workspace = path.resolve(process.argv[2] ?? "");
  const family = process.argv[3] ?? "";
  const result = await verifyWorkspace(workspace, family);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
