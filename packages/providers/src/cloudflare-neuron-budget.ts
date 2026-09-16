import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRequest, Usage } from "./chat-types.js";

export const CLOUDFLARE_PROVIDER_ID = "cloudflare-workers-ai";
export const CLOUDFLARE_INCLUDED_DAILY_NEURONS = 10_000;
export const CLOUDFLARE_SAFE_DAILY_NEURON_CEILING = 8_000;
export const CLOUDFLARE_NEURON_BUDGET_POLICY_VERSION = "cloudflare-neuron-budget/v1";

export type CloudflareUsageObservation = {
  utcDay: string;
  usedNeurons: number;
  source: "account-dashboard" | "provider-api";
  observedAt: string;
};

export interface CloudflareUsageSource {
  read(utcDay: string): Promise<CloudflareUsageObservation | undefined>;
}

export interface CloudflareNeuronRate {
  inputNeuronsPerMillion: number;
  cachedInputNeuronsPerMillion?: number;
  outputNeuronsPerMillion: number;
}

/** Current official LLM neuron rates used by the conservative request estimator. */
export const CLOUDFLARE_LLM_NEURON_RATES: Readonly<Record<string, CloudflareNeuronRate>> = {
  "@cf/openai/gpt-oss-120b": { inputNeuronsPerMillion: 31_818, outputNeuronsPerMillion: 68_182 },
  "@cf/openai/gpt-oss-20b": { inputNeuronsPerMillion: 18_182, outputNeuronsPerMillion: 27_273 },
  "@cf/qwen/qwen3.8-27b": { inputNeuronsPerMillion: 40_909, outputNeuronsPerMillion: 290_909 },
  "@cf/zai-org/glm-4.7-flash": { inputNeuronsPerMillion: 5_500, outputNeuronsPerMillion: 36_400 },
  "@cf/nvidia/nemotron-3-120b-a12b": { inputNeuronsPerMillion: 45_455, outputNeuronsPerMillion: 136_364 },
  "@cf/moonshotai/kimi-k2.6": { inputNeuronsPerMillion: 86_364, cachedInputNeuronsPerMillion: 14_545, outputNeuronsPerMillion: 363_636 },
  "@cf/zai-org/glm-5.2": { inputNeuronsPerMillion: 127_273, cachedInputNeuronsPerMillion: 23_636, outputNeuronsPerMillion: 400_000 },
  "@cf/zai-org/glm-5.3": { inputNeuronsPerMillion: 127_273, cachedInputNeuronsPerMillion: 23_636, outputNeuronsPerMillion: 400_000 },
  "@cf/zai-org/glm-5.3-flash": { inputNeuronsPerMillion: 13_636, cachedInputNeuronsPerMillion: 2_727, outputNeuronsPerMillion: 45_455 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { inputNeuronsPerMillion: 40_000, cachedInputNeuronsPerMillion: 1_273, outputNeuronsPerMillion: 120_000 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { inputNeuronsPerMillion: 120_000, cachedInputNeuronsPerMillion: 4_000, outputNeuronsPerMillion: 360_000 },
};

export type CloudflareNeuronBudgetErrorCode =
  | "CLOUDFLARE_USAGE_UNKNOWN"
  | "CLOUDFLARE_DAILY_SAFE_BUDGET_EXHAUSTED"
  | "CLOUDFLARE_NEURON_ESTIMATE_UNKNOWN"
  | "CLOUDFLARE_OUTPUT_BOUND_UNKNOWN"
  | "CLOUDFLARE_BUDGET_STATE_UNAVAILABLE"
  | "CLOUDFLARE_BUDGET_STATE_CORRUPT"
  | "CLOUDFLARE_SETTLEMENT_EXCEEDS_RESERVATION"
  | "CLOUDFLARE_REQUEST_ALREADY_SETTLED";

export class CloudflareNeuronBudgetError extends Error {
  constructor(
    public readonly code: CloudflareNeuronBudgetErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CloudflareNeuronBudgetError";
  }
}

export interface CloudflareNeuronBudgetSnapshot {
  utcDay: string;
  observedUsedNeurons: number;
  committedNeurons: number;
  reservedNeurons: number;
}

export interface CloudflareNeuronBudgetStore {
  reserve(params: {
    requestId: string;
    utcDay: string;
    observedUsedNeurons: number;
    estimatedNeurons: number;
    ceilingNeurons: number;
  }): Promise<{ reservationId: string; estimatedNeurons: number }>;
  settle(params: { reservationId: string; actualNeurons: number }): Promise<void>;
  release(params: { reservationId: string }): Promise<void>;
  snapshot?(utcDay: string): CloudflareNeuronBudgetSnapshot | undefined;
}

export interface CloudflareNeuronBudgetGuardOptions {
  store: CloudflareNeuronBudgetStore;
  usageSource: CloudflareUsageSource;
  now?: () => Date;
  safeDailyCeiling?: number;
  rates?: Readonly<Record<string, CloudflareNeuronRate>>;
}

export interface CloudflareNeuronReservation {
  readonly reservationId: string;
  readonly estimatedNeurons: number;
  settleUsage(usage?: Usage): Promise<void>;
  release(): Promise<void>;
}

/**
 * Application-side Workers AI cost gate. There is intentionally no paid-overflow switch: every
 * request must fit the CodeForge ceiling, and missing account usage or model pricing blocks before
 * the upstream request is constructed.
 */
export class CloudflareNeuronBudgetGuard {
  private readonly store: CloudflareNeuronBudgetStore;
  private readonly usageSource: CloudflareUsageSource;
  private readonly now: () => Date;
  private readonly safeDailyCeiling: number;
  private readonly rates: Readonly<Record<string, CloudflareNeuronRate>>;

  constructor(options: CloudflareNeuronBudgetGuardOptions) {
    const ceiling = options.safeDailyCeiling ?? CLOUDFLARE_SAFE_DAILY_NEURON_CEILING;
    if (!Number.isInteger(ceiling) || ceiling <= 0 || ceiling > CLOUDFLARE_INCLUDED_DAILY_NEURONS) {
      throw new Error(`Cloudflare safe daily ceiling must be an integer between 1 and ${CLOUDFLARE_INCLUDED_DAILY_NEURONS}`);
    }
    this.store = options.store;
    this.usageSource = options.usageSource;
    this.now = options.now ?? (() => new Date());
    this.safeDailyCeiling = ceiling;
    this.rates = options.rates ?? CLOUDFLARE_LLM_NEURON_RATES;
  }

  get policyVersion(): string {
    return CLOUDFLARE_NEURON_BUDGET_POLICY_VERSION;
  }

  get ceilingNeurons(): number {
    return this.safeDailyCeiling;
  }

  async reserve(req: ChatRequest): Promise<CloudflareNeuronReservation> {
    const utcDay = utcDayOf(this.now());
    const observation = await this.usageSource.read(utcDay);
    if (!observation || observation.utcDay !== utcDay || !validUsageSource(observation.source) || !validNeuronCount(observation.usedNeurons)) {
      throw new CloudflareNeuronBudgetError(
        "CLOUDFLARE_USAGE_UNKNOWN",
        `Trustworthy Workers AI usage for UTC day ${utcDay} is unavailable; withholding inference`,
      );
    }
    const estimatedNeurons = estimateCloudflareRequestNeurons(req, this.rates);
    let reservation: { reservationId: string; estimatedNeurons: number };
    try {
      reservation = await this.store.reserve({
        requestId: randomUUID(),
        utcDay,
        observedUsedNeurons: observation.usedNeurons,
        estimatedNeurons,
        ceilingNeurons: this.safeDailyCeiling,
      });
    } catch (error: unknown) {
      if (error instanceof CloudflareNeuronBudgetError) throw error;
      throw new CloudflareNeuronBudgetError(
        "CLOUDFLARE_BUDGET_STATE_UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      reservationId: reservation.reservationId,
      estimatedNeurons: reservation.estimatedNeurons,
      settleUsage: async (usage?: Usage) => {
        const actualNeurons = usage ? estimateCloudflareUsageNeurons(req.model, usage, this.rates) : estimatedNeurons;
        await this.store.settle({ reservationId: reservation.reservationId, actualNeurons });
      },
      release: async () => {
        await this.store.release({ reservationId: reservation.reservationId });
      },
    };
  }

  /** A cached snapshot can keep an exhausted route out of adaptive selection without an upstream call. */
  canRoute(modelId: string): boolean {
    if (!this.rates[modelId]) return false;
    const snapshot = this.store.snapshot?.(utcDayOf(this.now()));
    if (!snapshot) return false;
    return Math.max(snapshot.observedUsedNeurons, snapshot.committedNeurons) + snapshot.reservedNeurons < this.safeDailyCeiling;
  }
}

export function createFailClosedCloudflareNeuronBudgetGuard(): CloudflareNeuronBudgetGuard {
  return new CloudflareNeuronBudgetGuard({
    store: new InMemoryCloudflareNeuronBudgetStore(),
    usageSource: { read: async () => undefined },
  });
}

export function estimateCloudflareRequestNeurons(
  req: ChatRequest,
  rates: Readonly<Record<string, CloudflareNeuronRate>> = CLOUDFLARE_LLM_NEURON_RATES,
): number {
  const rate = rates[req.model];
  if (!rate) {
    throw new CloudflareNeuronBudgetError("CLOUDFLARE_NEURON_ESTIMATE_UNKNOWN", `No neuron conversion is recorded for model ${req.model}`);
  }
  const maxTokens = req.maxTokens;
  if (maxTokens === undefined || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new CloudflareNeuronBudgetError("CLOUDFLARE_OUTPUT_BOUND_UNKNOWN", "Cloudflare inference requires an explicit positive maxTokens bound");
  }
  const chars = (req.system?.length ?? 0)
    + req.messages.reduce((sum, message) => sum + message.content.length, 0)
    + JSON.stringify(req.tools ?? []).length;
  // Two characters/token is deliberately conservative for mixed-language prompts and tool JSON.
  const inputTokens = Math.max(1, Math.ceil(chars / 2));
  return neuronsForTokens(inputTokens, maxTokens, rate.inputNeuronsPerMillion, rate.outputNeuronsPerMillion);
}

export function estimateCloudflareUsageNeurons(
  modelId: string,
  usage: Usage,
  rates: Readonly<Record<string, CloudflareNeuronRate>> = CLOUDFLARE_LLM_NEURON_RATES,
): number {
  const rate = rates[modelId];
  if (!rate) {
    throw new CloudflareNeuronBudgetError("CLOUDFLARE_NEURON_ESTIMATE_UNKNOWN", `No neuron conversion is recorded for model ${modelId}`);
  }
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const uncached = usage.inputTokens - cached;
  const inputNeurons = (uncached * rate.inputNeuronsPerMillion + cached * (rate.cachedInputNeuronsPerMillion ?? rate.inputNeuronsPerMillion)) / 1_000_000;
  return Math.max(0, Math.ceil(inputNeurons + (usage.outputTokens * rate.outputNeuronsPerMillion) / 1_000_000));
}

export class StaticCloudflareUsageSource implements CloudflareUsageSource {
  private readonly observation: CloudflareUsageObservation;

  constructor(observation: CloudflareUsageObservation) {
    this.observation = observation;
  }

  async read(utcDay: string): Promise<CloudflareUsageObservation | undefined> {
    return this.observation.utcDay === utcDay ? { ...this.observation } : undefined;
  }
}

type StoredReservation = {
  reservationId: string;
  requestId: string;
  estimatedNeurons: number;
  status: "reserved" | "committed" | "released";
  actualNeurons?: number;
};

type MutableBudgetState = {
  version: 1;
  utcDay: string;
  observedUsedNeurons: number;
  committedNeurons: number;
  reservations: StoredReservation[];
};

function emptyState(utcDay: string): MutableBudgetState {
  return { version: 1, utcDay, observedUsedNeurons: 0, committedNeurons: 0, reservations: [] };
}

function reserveInState(state: MutableBudgetState, params: Parameters<CloudflareNeuronBudgetStore["reserve"]>[0]): { reservationId: string; estimatedNeurons: number } {
  if (state.utcDay !== params.utcDay) {
    state = emptyState(params.utcDay);
  }
  state.observedUsedNeurons = Math.max(state.observedUsedNeurons, params.observedUsedNeurons);
  const existing = state.reservations.find((reservation) => reservation.requestId === params.requestId);
  if (existing) {
    if (existing.status !== "reserved") {
      throw new CloudflareNeuronBudgetError("CLOUDFLARE_REQUEST_ALREADY_SETTLED", `Request ${params.requestId} is already ${existing.status}`);
    }
    return { reservationId: existing.reservationId, estimatedNeurons: existing.estimatedNeurons };
  }
  const reserved = state.reservations.filter((reservation) => reservation.status === "reserved").reduce((sum, reservation) => sum + reservation.estimatedNeurons, 0);
  if (Math.max(state.observedUsedNeurons, state.committedNeurons) + reserved + params.estimatedNeurons > params.ceilingNeurons) {
    throw new CloudflareNeuronBudgetError(
      "CLOUDFLARE_DAILY_SAFE_BUDGET_EXHAUSTED",
      `Request estimate ${params.estimatedNeurons} would exceed the ${params.ceilingNeurons}-Neuron CodeForge UTC-day ceiling`,
    );
  }
  const reservation = { reservationId: randomUUID(), requestId: params.requestId, estimatedNeurons: params.estimatedNeurons, status: "reserved" as const };
  state.reservations.push(reservation);
  return { reservationId: reservation.reservationId, estimatedNeurons: reservation.estimatedNeurons };
}

function settleInState(state: MutableBudgetState, reservationId: string, actualNeurons: number): void {
  const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId);
  if (!reservation) throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_UNAVAILABLE", `Unknown reservation ${reservationId}`);
  if (reservation.status === "committed") return;
  if (reservation.status === "released") return;
  if (!validNeuronCount(actualNeurons)) throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_UNAVAILABLE", "Invalid actual neuron count");
  if (actualNeurons > reservation.estimatedNeurons) {
    throw new CloudflareNeuronBudgetError("CLOUDFLARE_SETTLEMENT_EXCEEDS_RESERVATION", "Provider usage exceeded the pre-send neuron reservation");
  }
  reservation.status = "committed";
  reservation.actualNeurons = actualNeurons;
  state.committedNeurons += actualNeurons;
}

function releaseInState(state: MutableBudgetState, reservationId: string): void {
  const reservation = state.reservations.find((candidate) => candidate.reservationId === reservationId);
  if (!reservation) return;
  if (reservation.status === "reserved") reservation.status = "released";
}

export class InMemoryCloudflareNeuronBudgetStore implements CloudflareNeuronBudgetStore {
  private state: MutableBudgetState | undefined;

  async reserve(params: Parameters<CloudflareNeuronBudgetStore["reserve"]>[0]): Promise<{ reservationId: string; estimatedNeurons: number }> {
    if (!this.state || this.state.utcDay !== params.utcDay) this.state = emptyState(params.utcDay);
    return reserveInState(this.state, params);
  }

  async settle(params: { reservationId: string; actualNeurons: number }): Promise<void> {
    if (!this.state) throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_UNAVAILABLE", "No Cloudflare budget state exists");
    settleInState(this.state, params.reservationId, params.actualNeurons);
  }

  async release(params: { reservationId: string }): Promise<void> {
    if (this.state) releaseInState(this.state, params.reservationId);
  }

  snapshot(utcDay: string): CloudflareNeuronBudgetSnapshot | undefined {
    if (!this.state || this.state.utcDay !== utcDay) return undefined;
    return snapshotOf(this.state);
  }
}

/** Durable local ledger for desktop/CLI. The lock file serializes processes before read-modify-write. */
export class FileCloudflareNeuronBudgetStore implements CloudflareNeuronBudgetStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private lastState: MutableBudgetState | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async reserve(params: Parameters<CloudflareNeuronBudgetStore["reserve"]>[0]): Promise<{ reservationId: string; estimatedNeurons: number }> {
    return this.withLock(async () => {
      const state = await this.readState(params.utcDay);
      const result = reserveInState(state, params);
      await this.writeState(state);
      this.lastState = state;
      return result;
    });
  }

  async settle(params: { reservationId: string; actualNeurons: number }): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState(this.lastState?.utcDay ?? utcDayOf(new Date()));
      settleInState(state, params.reservationId, params.actualNeurons);
      await this.writeState(state);
      this.lastState = state;
    });
  }

  async release(params: { reservationId: string }): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState(this.lastState?.utcDay ?? utcDayOf(new Date()));
      releaseInState(state, params.reservationId);
      await this.writeState(state);
      this.lastState = state;
    });
  }

  snapshot(utcDay: string): CloudflareNeuronBudgetSnapshot | undefined {
    return this.lastState?.utcDay === utcDay ? snapshotOf(this.lastState) : undefined;
  }

  private async readState(utcDay: string): Promise<MutableBudgetState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MutableBudgetState;
      if (parsed.version !== 1 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(parsed.utcDay) || !validNeuronCount(parsed.observedUsedNeurons) || !validNeuronCount(parsed.committedNeurons) || !Array.isArray(parsed.reservations)) {
        throw new Error("invalid state shape");
      }
      if (parsed.utcDay !== utcDay) return emptyState(utcDay);
      return parsed;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyState(utcDay);
      if (error instanceof CloudflareNeuronBudgetError) throw error;
      throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_CORRUPT", "Cloudflare neuron ledger is unreadable");
    }
  }

  private async writeState(state: MutableBudgetState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state), "utf8");
      await import("node:fs/promises").then(({ rename }) => rename(tempPath, this.filePath));
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const handle = await open(this.lockPath, "wx");
        try {
          return await work();
        } finally {
          await handle.close();
          await unlink(this.lockPath).catch(() => undefined);
        }
      } catch (error: unknown) {
        if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        if (error instanceof CloudflareNeuronBudgetError) throw error;
        throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_UNAVAILABLE", error instanceof Error ? error.message : String(error));
      }
    }
    throw new CloudflareNeuronBudgetError("CLOUDFLARE_BUDGET_STATE_UNAVAILABLE", "Timed out acquiring the Cloudflare neuron ledger lock");
  }
}

function neuronsForTokens(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number): number {
  return Math.max(1, Math.ceil((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000));
}

function validNeuronCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validUsageSource(value: unknown): value is CloudflareUsageObservation["source"] {
  return value === "account-dashboard" || value === "provider-api";
}

function snapshotOf(state: MutableBudgetState): CloudflareNeuronBudgetSnapshot {
  return {
    utcDay: state.utcDay,
    observedUsedNeurons: state.observedUsedNeurons,
    committedNeurons: state.committedNeurons,
    reservedNeurons: state.reservations.filter((reservation) => reservation.status === "reserved").reduce((sum, reservation) => sum + reservation.estimatedNeurons, 0),
  };
}

function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}
