import { describe, it, expect } from "vitest";
import {
  createLease,
  createTaskAuthority,
  classifyAction,
  normalizePermissionMode,
  normalizePlanMode,
  type ActionDescriptor,
  type PolicyReceipt,
} from "../src/index.js";

const read = (over: Partial<ActionDescriptor> = {}): ActionDescriptor => ({
  tool: "read_file",
  action: "read",
  reason: "read a file",
  insideWorkspace: true,
  risk: "safe",
  ...over,
});

const write = (over: Partial<ActionDescriptor> = {}): ActionDescriptor => ({
  tool: "write_file",
  action: "write",
  reason: "edit a file",
  targetPath: "src/app.ts",
  insideWorkspace: true,
  risk: "moderate",
  ...over,
});

const exec = (command: string, over: Partial<ActionDescriptor> = {}): ActionDescriptor => ({
  tool: "run_command",
  action: "exec",
  reason: `run ${command}`,
  command,
  insideWorkspace: true,
  risk: "moderate",
  ...over,
});

const authority = (over: Partial<Parameters<typeof createLease>[0]> = {}, onReceipt?: (r: PolicyReceipt) => void) =>
  createTaskAuthority(
    createLease({ sessionId: "s1", workspaceRoot: "C:/repo", ...over }),
    onReceipt,
  );

describe("normalizePermissionMode", () => {
  it("passes through the current vocabulary", () => {
    expect(normalizePermissionMode("auto_review")).toBe("auto_review");
    expect(normalizePermissionMode("ask_more")).toBe("ask_more");
    expect(normalizePermissionMode("full_autonomy")).toBe("full_autonomy");
  });

  it("maps legacy policy values conservatively", () => {
    expect(normalizePermissionMode("allow")).toBe("full_autonomy");
    expect(normalizePermissionMode("ask")).toBe("ask_more");
    expect(normalizePermissionMode("deny")).toBe("ask_more");
  });

  it("never widens authority for unknown or missing values", () => {
    expect(normalizePermissionMode(undefined)).toBe("auto_review");
    expect(normalizePermissionMode(null)).toBe("auto_review");
    expect(normalizePermissionMode("everything")).toBe("auto_review");
    expect(normalizePermissionMode("")).toBe("auto_review");
  });
});

describe("normalizePlanMode", () => {
  it("only honors the explicit review_first value", () => {
    expect(normalizePlanMode("review_first")).toBe("review_first");
    expect(normalizePlanMode("auto")).toBe("auto");
    expect(normalizePlanMode(undefined)).toBe("auto");
    expect(normalizePlanMode("bogus")).toBe("auto");
  });
});

describe("classifyAction tiers", () => {
  it("T0: reads inside workspace, checkpoints, read-only commands", () => {
    expect(classifyAction(read()).tier).toBe(0);
    expect(classifyAction({ ...read(), action: "checkpoint" }).tier).toBe(0);
    expect(classifyAction(exec("npm test", { category: "read-only" })).tier).toBe(0);
    expect(classifyAction(exec("git status", { category: "read-only" })).tier).toBe(0);
  });

  it("T1: reversible workspace writes and verification/build commands", () => {
    expect(classifyAction(write()).tier).toBe(1);
    expect(classifyAction(exec("npm run build", { category: "project-modifying" })).tier).toBe(1);
    expect(classifyAction(exec("vite build", { category: "project-modifying" })).tier).toBe(1);
    expect(classifyAction(exec("npx tsc --noEmit", { category: "project-modifying" })).tier).toBe(1);
    expect(classifyAction(exec("vitest run", { category: "project-modifying" })).tier).toBe(1);
  });

  it("T2: reads outside workspace, installs, unclassified workspace commands", () => {
    expect(classifyAction(read({ insideWorkspace: false })).tier).toBe(2);
    expect(classifyAction(exec("npm install lodash", { category: "project-modifying" })).tier).toBe(2);
    expect(classifyAction(exec("pip install requests", { category: "project-modifying" })).tier).toBe(2);
    expect(classifyAction(exec("node scripts/custom.js", { category: "project-modifying" })).tier).toBe(2);
  });

  it("T3: writes outside workspace, externally visible effects, high-risk", () => {
    expect(classifyAction(write({ insideWorkspace: false, targetPath: "C:/Windows/x" })).tier).toBe(3);
    expect(classifyAction(exec("git push origin main")).tier).toBe(3);
    expect(classifyAction(exec("gh pr create --fill")).tier).toBe(3);
    expect(classifyAction(exec("npm publish")).tier).toBe(3);
    expect(classifyAction(exec("wrangler deploy")).tier).toBe(3);
    expect(classifyAction(exec("rm -rf build", { risk: "high" })).tier).toBe(3);
    expect(classifyAction(exec("curl https://x", { category: "network-sensitive" })).tier).toBe(3);
  });

  it("T4: critical classification always wins", () => {
    expect(classifyAction(exec("rm -rf /", { risk: "critical" })).tier).toBe(4);
    expect(classifyAction(read({ risk: "critical" })).tier).toBe(4);
  });
});

describe("TaskAuthority.resolve — routine work flows", () => {
  it("allows reads, writes, tests, builds, and diff inspection without asking in every mode", () => {
    for (const mode of ["auto_review", "ask_more", "full_autonomy"] as const) {
      const a = authority({ permissionMode: mode });
      expect(a.resolve(read()).decision).toBe("allow");
      expect(a.resolve(exec("npm test", { category: "read-only" })).decision).toBe("allow");
      expect(a.resolve(exec("git diff HEAD", { category: "read-only" })).decision).toBe("allow");
    }
  });

  it("auto_review and full_autonomy let T1 workspace edits flow; ask_more asks", () => {
    expect(authority({ permissionMode: "auto_review" }).resolve(write()).decision).toBe("allow");
    expect(authority({ permissionMode: "full_autonomy" }).resolve(write()).decision).toBe("allow");
    expect(authority({ permissionMode: "ask_more" }).resolve(write()).decision).toBe("ask");
    expect(authority({ permissionMode: "auto_review" }).resolve(exec("npm run build")).decision).toBe("allow");
    expect(authority({ permissionMode: "ask_more" }).resolve(exec("npm run build")).decision).toBe("ask");
  });

  it("T2 project-modifying commands ask except under full_autonomy", () => {
    expect(authority({ permissionMode: "auto_review" }).resolve(exec("npm install lodash")).decision).toBe("ask");
    expect(authority({ permissionMode: "ask_more" }).resolve(exec("npm install lodash")).decision).toBe("ask");
    expect(authority({ permissionMode: "full_autonomy" }).resolve(exec("npm install lodash")).decision).toBe("allow");
  });
});

describe("TaskAuthority.resolve — boundaries always escalate", () => {
  it("T3/T4 ask under every mode, including full_autonomy", () => {
    for (const mode of ["auto_review", "ask_more", "full_autonomy"] as const) {
      const a = authority({ permissionMode: mode });
      expect(a.resolve(write({ insideWorkspace: false, targetPath: "C:/Windows/x" })).decision).toBe("ask");
      expect(a.resolve(exec("git push origin main")).decision).toBe("ask");
      expect(a.resolve(exec("npm publish")).decision).toBe("ask");
      expect(a.resolve(exec("rm -rf /", { risk: "critical" })).decision).toBe("ask");
    }
  });

  it("read-only subagent roles are denied mutations regardless of mode", () => {
    for (const actor of ["explorer", "planner", "reviewer"] as const) {
      const a = authority({ permissionMode: "full_autonomy" });
      expect(a.resolve(write({ actor })).decision).toBe("deny");
      expect(a.resolve(exec("npm test", { category: "read-only", actor })).decision).toBe("allow");
      expect(a.resolve(exec("npm install x", { actor })).decision).toBe("deny");
    }
  });
});

describe("TaskAuthority grants", () => {
  it("a user 'Allow for task' grant covers later matching T≤2 actions", () => {
    const a = authority({ permissionMode: "auto_review" });
    const desc = exec("npm install lodash");
    expect(a.resolve(desc).decision).toBe("ask");
    const grant = a.grantPatternFor(desc);
    expect(grant).toBeDefined();
    a.addGrant(grant!);
    const again = a.resolve(exec("npm install react"));
    expect(again.decision).toBe("allow");
    expect(again.grantPattern).toBe("command_prefix:npm install");
  });

  it("directory grants cover sibling paths under the granted directory", () => {
    // Reads outside the workspace are T2 — the only tier where a directory grant applies.
    const a = authority({ permissionMode: "auto_review" });
    a.addGrant({ kind: "directory", value: "C:/shared/notes", scope: "task", grantedBy: "user", createdAt: new Date().toISOString() });
    expect(a.resolve(read({ insideWorkspace: false, targetPath: "C:/shared/notes/b.md" })).decision).toBe("allow");
    expect(a.resolve(read({ insideWorkspace: false, targetPath: "C:/shared/other/c.md" })).decision).toBe("ask");
  });

  it("never mints or honors grants for T3/T4 boundaries", () => {
    const a = authority({ permissionMode: "auto_review" });
    expect(a.grantPatternFor(exec("git push origin main"))).toBeUndefined();
    // Out-of-workspace writes are T3 — no persistent grant is offered for them.
    expect(a.grantPatternFor(write({ insideWorkspace: false, targetPath: "C:/Windows/x" }))).toBeUndefined();
    a.addGrant({ kind: "action", value: "exec", scope: "task", grantedBy: "user", createdAt: new Date().toISOString() });
    expect(a.resolve(exec("git push origin main")).decision).toBe("ask");
  });

  it("deduplicates identical grants", () => {
    const a = authority();
    const g = { kind: "action" as const, value: "exec", scope: "task" as const, grantedBy: "user" as const, createdAt: "now" };
    a.addGrant(g);
    a.addGrant({ ...g, createdAt: "later" });
    expect(a.getLease().grants).toHaveLength(1);
  });
});

describe("receipts", () => {
  it("emits a receipt for every decision with tier, decision, and source", () => {
    const sink: PolicyReceipt[] = [];
    const a = authority({ permissionMode: "auto_review" }, (r) => sink.push(r));
    a.resolve(read());
    a.resolve(write());
    a.resolve(exec("git push origin main"));
    expect(sink).toHaveLength(3);
    expect(sink[0]).toMatchObject({ tool: "read_file", tier: 0, decision: "allow", source: "deterministic" });
    expect(sink[1]).toMatchObject({ tool: "write_file", tier: 1, decision: "allow", source: "auto_review" });
    expect(sink[2]).toMatchObject({ tier: 3, decision: "ask", source: "deterministic" });
    expect(a.getReceipts()).toHaveLength(3);
  });

  it("a throwing receipt sink never changes the decision", () => {
    const a = authority({}, () => { throw new Error("sink down"); });
    expect(a.resolve(exec("git push origin main")).decision).toBe("ask");
  });
});

describe("live mode retuning", () => {
  it("setModes changes resolution without invalidating grants", () => {
    const a = authority({ permissionMode: "auto_review" });
    expect(a.resolve(write()).decision).toBe("allow");
    a.setModes({ permissionMode: "ask_more" });
    expect(a.resolve(write()).decision).toBe("ask");
    a.setModes({ permissionMode: "full_autonomy" });
    expect(a.resolve(exec("npm install x")).decision).toBe("allow");
    expect(a.getLease().grants).toHaveLength(0);
  });
});
