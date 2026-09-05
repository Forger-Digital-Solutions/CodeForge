import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventStore, createSessionPersistence, type SessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../../src/agent-runtime.js";
import { createWorkspaceService } from "../../src/workspace-service.js";
import { createMissionSupervisor, type MissionSupervisor } from "../../src/mission-supervisor.js";
import type { MissionEvent } from "../../src/mission-state.js";
import type { ParallelEvent } from "../../src/parallel-state.js";

const execFile = promisify(execFileCallback);
export const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>((resolve) => { this.resolve = resolve; }); }
}

export type ProviderRole = "mission-planner" | "replanner" | "explorer" | "planner" | "coder" | "reviewer" | "other";

export interface CapturedRequest { role: ProviderRole; tag: string; goalHint: string; payload: string }

export interface ScriptContext { request: ChatRequest; role: ProviderRole; all: string; tag: string; goalHint: string; call: number }

/** Deterministic provider: every reply is chosen by a scenario script, never by a real model. */
export class MissionProvider implements ProviderAdapter {
  readonly providerId = "cf09-mission";
  readonly isTestProvider = true;
  readonly captured: CapturedRequest[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly script: (context: ScriptContext) => unknown) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }

  private roleOf(system: string): ProviderRole {
    if (system.includes("CodeForge Mission Planner")) return "mission-planner";
    if (system.includes("CodeForge Replanner")) return "replanner";
    if (system.includes("CodeForge Explorer")) return "explorer";
    if (system.includes("CodeForge Planner")) return "planner";
    if (system.includes("CodeForge Coder")) return "coder";
    if (system.includes("CodeForge Reviewer")) return "reviewer";
    return "other";
  }

  /** Stable request identity: role plus the runtime-authored goal line. */
  private tagOf(role: ProviderRole, all: string): string {
    const goal = /Goal:\r?\n(.*)/.exec(all)?.[1]?.trim() ?? "";
    return `${role}|${goal}`;
  }

  count(tag: string): number { return this.counts.get(tag) ?? 0; }
  requestsFor(predicate: (entry: CapturedRequest) => boolean): CapturedRequest[] { return this.captured.filter(predicate); }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    const role = this.roleOf(system);
    const tag = this.tagOf(role, all);
    const call = (this.counts.get(tag) ?? 0) + 1;
    this.counts.set(tag, call);
    this.captured.push({ role, tag, goalHint: tag.split("|")[1] ?? "", payload: JSON.stringify(request) });
    const reply = await this.script({ request, role, all, tag, goalHint: tag.split("|")[1] ?? "", call });
    if (reply === undefined) { yield { type: "text_delta", delta: "{}" }; yield { type: "finish", finishReason: "stop" }; return; }
    if (typeof reply === "string") { yield { type: "text_delta", delta: reply }; yield { type: "finish", finishReason: "stop" }; return; }
    const scripted = reply as { text?: string; write?: { path: string; content: string }; toolCallId?: string };
    if (scripted.write) {
      if (scripted.text) yield { type: "text_delta", delta: scripted.text };
      const id = scripted.toolCallId ?? `write-${call}`;
      yield { type: "tool_call_started", toolCallId: id, toolName: "write_file" };
      yield { type: "tool_call_completed", toolCallId: id, toolName: "write_file", arguments: JSON.stringify(scripted.write) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: scripted.text ?? JSON.stringify(reply) };
    yield { type: "finish", finishReason: "stop" };
  }
}

export const reviewerPass = (summary = "approved") => JSON.stringify({ verdict: "pass", findings: [], summary });
export const reviewerBlock = (message: string, id = "cf09-block") =>
  JSON.stringify({ verdict: "revision_required", findings: [{ id, severity: "blocking", category: "correctness", message }], summary: "blocking finding" });

export interface MissionRepoFiles { [relativePath: string]: string }

/** Base repository for the long-horizon feature-flag mission. Stubs fail their tests on purpose. */
export const FEATURE_FLAG_REPO: MissionRepoFiles = {
  "package.json": JSON.stringify({ type: "module" }),
  "src/settings.mjs": "export function loadFlags() { return null; }\nexport function saveFlags() { return null; }\n",
  "src/defaults.mjs": "export function defaultFlags() { return null; }\n",
  "src/server.mjs": "export function handleFlagRequest() { return null; }\n",
  "src/feature.mjs": "export function runFeature() { return 'default'; }\n",
  "ui/settings-view.mjs": "export function renderToggle() { return null; }\n",
  "test/settings.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { loadFlags, saveFlags } from '../src/settings.mjs';\nimport { defaultFlags } from '../src/defaults.mjs';\ntest('defaults', () => assert.deepEqual(defaultFlags(), { alpha: false }));\ntest('roundtrip', () => assert.deepEqual(loadFlags(saveFlags({ alpha: true })), { alpha: true }));\n",
  "test/feature.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { runFeature } from '../src/feature.mjs';\ntest('default behavior unchanged', () => assert.equal(runFeature(), 'default'));\n",
  "test/server.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { handleFlagRequest } from '../src/server.mjs';\ntest('server exposes flags', () => assert.equal(handleFlagRequest({ alpha: true }), '{\"alpha\":true}'));\n",
  "test/ui.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { renderToggle } from '../ui/settings-view.mjs';\ntest('ui toggle on', () => assert.equal(renderToggle('alpha', true), '[x] alpha'));\ntest('ui toggle off', () => assert.equal(renderToggle('alpha', false), '[ ] alpha'));\n",
};

export const IMPLEMENTATIONS = {
  settings: { path: "src/settings.mjs", content: "export function saveFlags(flags) { return JSON.stringify(flags); }\nexport function loadFlags(raw) { return raw ? JSON.parse(raw) : { alpha: false }; }\n" },
  defaults: { path: "src/defaults.mjs", content: "export function defaultFlags() { return { alpha: false }; }\n" },
  server: { path: "src/server.mjs", content: "export function handleFlagRequest(flags) { return JSON.stringify(flags); }\n" },
  brokenUi: { path: "ui/settings-view.mjs", content: "export function renderToggle(name) { return '[?] ' + name; }\n" },
  fixedUi: { path: "ui/settings-view.mjs", content: "export function renderToggle(name, on) { return (on ? '[x] ' : '[ ] ') + name; }\n" },
  certification: { path: "docs/mission-certification.md", content: "# Mission certification\n\nFeature flags verified across persistence, server and UI.\n" },
} as const;

export async function createRepo(files: MissionRepoFiles = FEATURE_FLAG_REPO, prefix = "cf09-repo-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execFile("git", ["init", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root });
  await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

export interface MissionHarness {
  supervisor: MissionSupervisor;
  provider: MissionProvider;
  persistence: SessionPersistence;
  workspaceService: ReturnType<typeof createWorkspaceService>;
  missionEvents: MissionEvent[];
  parallelEvents: ParallelEvent[];
}

export interface HarnessOptions {
  repoDir: string;
  worktreeDir: string;
  sessionId: string;
  script: (context: ScriptContext) => unknown;
  persistence?: SessionPersistence;
  dbPath?: string;
  provider?: MissionProvider;
}

export function createHarness(options: HarnessOptions): MissionHarness {
  const persistence = options.persistence ?? createSessionPersistence(options.dbPath ? { dbPath: options.dbPath } : undefined);
  const provider = options.provider ?? new MissionProvider(options.script);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord());
  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: options.worktreeDir });
  const agentRuntime = createAgentRuntime({ sessionId: options.sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: options.repoDir });
  const missionEvents: MissionEvent[] = [];
  const parallelEvents: ParallelEvent[] = [];
  const supervisor = createMissionSupervisor({
    workspaceService, agentRuntime, persistence,
    onEvent: (event) => { missionEvents.push(event); },
    onParallelEvent: (event) => { parallelEvents.push(event); },
  });
  return { supervisor, provider, persistence, workspaceService, missionEvents, parallelEvents };
}

export interface MilestoneSpec {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  workstreams: Array<{ id: string; objective: string; expectedFiles: string[]; write: { path: string; content: string } }>;
}

/**
 * Builds a scenario script from a milestone table: the mission planner, wave planners, coders and
 * reviewers all answer deterministically from the same declarative spec.
 */
export function scriptFromSpec(options: {
  missionId: string;
  goal: string;
  criteria: Array<{ id: string; description: string; mandatory?: boolean }>;
  plans: Array<{ milestones: MilestoneSpec[]; assumptions?: Array<{ id: string; statement: string }> }>;
  onCoder?: (workstreamId: string, call: number) => { path: string; content: string } | undefined;
  reviewer?: (context: ScriptContext) => string | undefined;
  explorer?: (context: ScriptContext) => string | undefined;
  finalReview?: (context: ScriptContext) => string | undefined;
}): (context: ScriptContext) => unknown {
  const planIndex = { value: 0 };
  const allMilestones = () => options.plans.flatMap((plan) => plan.milestones);
  return (context: ScriptContext) => {
    const { role, all, goalHint } = context;
    if (role === "mission-planner" && goalHint.startsWith("Compile acceptance criteria")) {
      return JSON.stringify({ summary: `Acceptance criteria for ${options.goal}`, criteria: options.criteria.map((criterion) => ({ id: criterion.id, description: criterion.description, mandatory: criterion.mandatory !== false })) });
    }
    if (role === "mission-planner" && goalHint.startsWith("Mission roadmap")) {
      planIndex.value = 0;
      const plan = options.plans[0]!;
      return JSON.stringify({ id: options.missionId, goal: options.goal, summary: "roadmap", milestones: plan.milestones.map(toPlanMilestone), ...(plan.assumptions ? { assumptions: plan.assumptions } : {}) });
    }
    if (role === "replanner") {
      planIndex.value = Math.min(planIndex.value + 1, options.plans.length - 1);
      const plan = options.plans[planIndex.value]!;
      return JSON.stringify({ id: options.missionId, goal: options.goal, summary: "revised roadmap", milestones: plan.milestones.map(toPlanMilestone), ...(plan.assumptions ? { assumptions: plan.assumptions } : {}) });
    }
    if (role === "explorer") return options.explorer?.(context) ?? JSON.stringify({ summary: "no assumption evidence", findings: [], evidence: [] });
    if (role === "planner") {
      const milestone = allMilestones().find((candidate) => goalHint.includes(`(mission milestone ${candidate.id})`));
      if (!milestone) return JSON.stringify({ id: "empty", goal: goalHint, summary: "none", workstreams: [{ id: "noop", title: "Noop", objective: "no change", dependencies: [] }] });
      return JSON.stringify({
        id: milestone.id, goal: milestone.objective, summary: milestone.title,
        workstreams: milestone.workstreams.map((workstream) => ({ id: workstream.id, title: workstream.id, objective: workstream.objective, dependencies: [], expectedFiles: workstream.expectedFiles })),
      });
    }
    if (role === "reviewer") {
      const scripted = options.reviewer?.(context);
      if (scripted !== undefined) return scripted;
      return reviewerPass();
    }
    if (role === "coder") {
      const workstream = allMilestones().flatMap((milestone) => milestone.workstreams).find((candidate) => all.includes(`"workstream":"${candidate.id}"`));
      if (!workstream) return { text: "no change" };
      if (context.request.messages.some((message) => message.role === "tool")) return { text: `${workstream.id} complete` };
      const override = options.onCoder?.(workstream.id, context.call);
      return { write: override ?? workstream.write };
    }
    return { text: "done" };
  };
}

function toPlanMilestone(milestone: MilestoneSpec) {
  return { id: milestone.id, title: milestone.title, objective: milestone.objective, dependencies: milestone.dependencies, acceptanceCriteria: milestone.acceptanceCriteria, verificationCommands: milestone.verificationCommands };
}

/** Small two-file repository used by the focused mission suites. */
export const SMALL_REPO: MissionRepoFiles = {
  "package.json": JSON.stringify({ type: "module" }),
  "src/one.mjs": "export function one() { return 'stub'; }\n",
  "src/two.mjs": "export function two() { return 'stub'; }\n",
  "test/one.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { one } from '../src/one.mjs';\ntest('one', () => assert.equal(one(), 'ONE'));\n",
  "test/two.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict';\nimport { two } from '../src/two.mjs';\ntest('two', () => assert.equal(two(), 'TWO'));\n",
};

export const SMALL_IMPL = {
  one: { path: "src/one.mjs", content: "export function one() { return 'ONE'; }\n" },
  two: { path: "src/two.mjs", content: "export function two() { return 'TWO'; }\n" },
  brokenTwo: { path: "src/two.mjs", content: "export function two() { return 'BROKEN'; }\n" },
} as const;

export const ONE_TEST = "node --test test/one.test.mjs";
export const TWO_TEST = "node --test test/two.test.mjs";

export function smallMilestones(secondWrite: { path: string; content: string } = SMALL_IMPL.two): MilestoneSpec[] {
  return [
    { id: "s-one", title: "First", objective: "Implement the first module", dependencies: [], acceptanceCriteria: ["AC-1"], verificationCommands: [ONE_TEST], workstreams: [{ id: "one-write", objective: "Implement src/one.mjs", expectedFiles: ["src/one.mjs"], write: SMALL_IMPL.one }] },
    { id: "s-two", title: "Second", objective: "Implement the second module", dependencies: ["s-one"], acceptanceCriteria: ["AC-2"], verificationCommands: [TWO_TEST], workstreams: [{ id: "two-write", objective: "Implement src/two.mjs", expectedFiles: ["src/two.mjs"], write: secondWrite }] },
  ];
}

export const SMALL_CRITERIA = [
  { id: "AC-1", description: "the first module returns ONE" },
  { id: "AC-2", description: "the second module returns TWO" },
];

/**
 * Faithful process-death fixture: the durable store stops accepting writes at a chosen event,
 * exactly as a killed process would, so the record left behind is written by production code.
 */
export function crashOnEvent(real: SessionPersistence, eventType: string): SessionPersistence {
  let tripped = false;
  const writes = new Set(["upsertWorkItem", "appendEvent", "upsertSession", "upsertTurn"]);
  const terminated = () => new Error("PROCESS_TERMINATED: durable store unavailable");
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      const name = String(property);
      return (...args: unknown[]) => {
        if (name === "appendEvent" && (args[0] as { type?: string } | undefined)?.type === eventType) { tripped = true; throw terminated(); }
        if (tripped && writes.has(name)) throw terminated();
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
