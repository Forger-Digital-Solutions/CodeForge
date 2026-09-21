import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createForgeGreenAdvisor, type ForgeGreenAdvisor } from "@codeforge/forge-green";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createForgeGreenCacheStore, type ForgeGreenCacheStore } from "@codeforge/sessions";
import type { ArmId } from "./run-record.js";

/**
 * Arm configurations (protocol §3). The two arms differ ONLY in the switches enumerated in
 * `ARM_SWITCHES`; `assertArmsDifferOnlyInSwitches` is the tripwire that fails the harness if
 * anything else ever diverges. Ablation arms are single-switch variants of these two.
 */

export interface ArmConfiguration {
  arm: ArmId | "ablation";
  label: string;
  /** ForgeGreen advisor: in-flight duplicate request coalescing, stable-prefix observation. */
  forgeGreenAdvisor: boolean;
  /** FG-1C duplicate read-only action suppression (incl. R22 external-read dedup). */
  duplicateSuppression: boolean;
  /** FG-1B tool-output compression. */
  toolOutputCompression: boolean;
  /** FG-1D canonical analysis cache + FG-3D Context Pages (persistent store). */
  forgeGreenCache: boolean;
  /** Proactive repository-intelligence context planning at bootstrap (FG-3 narrow planner). */
  contextPlanner: boolean;
  /** Bounded mission memory delivered to planner/replanner/reviewer prompts. */
  memoryDelivery: boolean;
  /** FG-12F cost-gated ForgeVerify evidence reuse. */
  verificationReuse: boolean;
  /** Adaptive topology (complexity → team plan) vs a fixed single coder. */
  topology: "single_agent" | "adaptive";
}

export const ARM_SWITCHES = [
  "forgeGreenAdvisor",
  "duplicateSuppression",
  "toolOutputCompression",
  "forgeGreenCache",
  "contextPlanner",
  "memoryDelivery",
  "verificationReuse",
  "topology",
] as const satisfies readonly (keyof ArmConfiguration)[];

export const CONTROL_ARM: ArmConfiguration = Object.freeze({
  arm: "control",
  label: "ARM A — CONTROL (ForgeGreen OFF, pull-only context, single agent, fresh verification)",
  forgeGreenAdvisor: false,
  duplicateSuppression: false,
  toolOutputCompression: false,
  forgeGreenCache: false,
  contextPlanner: false,
  memoryDelivery: false,
  verificationReuse: false,
  topology: "single_agent",
});

export const OPTIMIZED_ARM: ArmConfiguration = Object.freeze({
  arm: "optimized",
  label: "ARM B — OPTIMIZED (production defaults)",
  forgeGreenAdvisor: true,
  duplicateSuppression: true,
  toolOutputCompression: true,
  forgeGreenCache: true,
  contextPlanner: true,
  memoryDelivery: true,
  verificationReuse: true,
  topology: "adaptive",
});

export function armConfigurationFor(arm: ArmId): ArmConfiguration {
  return arm === "control" ? CONTROL_ARM : OPTIMIZED_ARM;
}

/** Single-switch ablation from a base arm (protocol §3.3). */
export function ablationArm(base: ArmConfiguration, toggle: (typeof ARM_SWITCHES)[number], label?: string): ArmConfiguration {
  const value = base[toggle];
  const flipped = toggle === "topology" ? (value === "adaptive" ? "single_agent" : "adaptive") : !value;
  return { ...base, arm: "ablation", label: label ?? `${base.arm} with ${toggle}=${String(flipped)}`, [toggle]: flipped } as ArmConfiguration;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function armConfigurationDigest(config: ArmConfiguration): string {
  const { label: _label, ...rest } = config;
  return crypto.createHash("sha256").update(stableJson(rest)).digest("hex");
}

/**
 * Tripwire (protocol §3.2, §15): the control and optimized arms must differ in every listed
 * switch and in nothing else. Throws with the offending keys.
 */
export function assertArmsDifferOnlyInSwitches(control: ArmConfiguration = CONTROL_ARM, optimized: ArmConfiguration = OPTIMIZED_ARM): void {
  const keys = new Set<string>([...Object.keys(control), ...Object.keys(optimized)]);
  keys.delete("arm");
  keys.delete("label");
  const controlRecord = control as unknown as Record<string, unknown>;
  const optimizedRecord = optimized as unknown as Record<string, unknown>;
  const differing = [...keys].filter((key) => controlRecord[key] !== optimizedRecord[key]);
  const expected = [...ARM_SWITCHES].sort();
  const actual = differing.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`arm tripwire: arms differ in [${actual.join(", ")}] but the protocol lists [${expected.join(", ")}]`);
  }
  for (const key of ARM_SWITCHES) {
    const off = key === "topology" ? "single_agent" : false;
    const on = key === "topology" ? "adaptive" : true;
    if (control[key] !== off) throw new Error(`arm tripwire: control.${key} must be ${String(off)}`);
    if (optimized[key] !== on) throw new Error(`arm tripwire: optimized.${key} must be ${String(on)}`);
  }
}

export interface ArmRuntimeMaterial {
  forgeGreen: ForgeGreenAdvisor;
  efficiencyControls: { duplicateSuppression: boolean; toolOutputCompression: boolean };
  repositoryIntelligenceFactory: () => RepositoryIntelligence;
  forgeGreenCacheStore?: ForgeGreenCacheStore;
  /** Release everything the material opened (cache db). */
  dispose(): Promise<void>;
}

/**
 * Materialise an arm into concrete runtime options. Each run gets its own cold index cache root
 * and its own cache database so no arm inherits state from a previous run (conservative for the
 * optimized arm, which in production would enjoy warm caches — stated as a limitation).
 */
export async function materializeArm(config: ArmConfiguration, runScratchDir: string): Promise<ArmRuntimeMaterial> {
  const indexRoot = path.join(runScratchDir, "repo-index");
  const factory = config.contextPlanner
    ? () => createRepositoryIntelligence({ cacheRoot: indexRoot, maxFiles: 25_000 })
    : () => {
        // The runtime's own degradation path: an unavailable repository-intelligence engine makes
        // context assembly fall back to Goal + role prompt (no proactive file selection). repo_*
        // pull tools still work — they open their own engine — so the tool set is identical.
        throw new Error("R23 control arm: proactive repository-intelligence context planning is disabled");
      };
  const cacheStore = config.forgeGreenCache
    ? await createForgeGreenCacheStore(path.join(runScratchDir, "forgegreen-cache.db")).catch(() => undefined)
    : undefined;
  return {
    forgeGreen: createForgeGreenAdvisor({ enabled: config.forgeGreenAdvisor }),
    efficiencyControls: { duplicateSuppression: config.duplicateSuppression, toolOutputCompression: config.toolOutputCompression },
    repositoryIntelligenceFactory: factory,
    ...(cacheStore ? { forgeGreenCacheStore: cacheStore } : {}),
    async dispose() {
      await cacheStore?.close().catch(() => undefined);
    },
  };
}

export function defaultRunScratchRoot(): string {
  return path.join(os.tmpdir(), "codeforge-r23");
}
