import crypto from "node:crypto";

export type R20EvidenceClass = "simulated" | "locally_emulated" | "staging" | "real_provider" | "production";
export type R20TaskType = "explain" | "locate" | "summarize" | "bug_fix" | "tests" | "feature" | "refactor" | "multi_file_bug" | "exploration" | "large_context" | "browser_research" | "subagent";
export type R20Topology = "T0" | "T1" | "T2" | "T3" | "T4" | "T5";
export type R20FaultKind = "success" | "rate_limit" | "server_error" | "timeout" | "malformed" | "connection_reset" | "offline" | "latency_spike" | "model_removed";
export type R20QueueState = "queued" | "waiting_for_capacity" | "reserving_route" | "dispatching" | "retrying_route" | "failover" | "cooldown" | "capacity_exhausted" | "completed" | "blocked" | "failed" | "cancelled";

export interface R20FaultWindow {
  startMs: number;
  endMs: number;
  kind: R20FaultKind;
  latencyMs?: number;
  retryAfterMs?: number;
}

export interface R20SyntheticRouteConfig {
  routeId: string;
  providerId: string;
  modelId: string;
  costClass: "PUBLIC_MANAGED_FREE" | "OWNER_DEV_FREE" | "USER_CONNECTED_FREE" | "BYOK" | "PAID" | "UNKNOWN";
  roles: string[];
  concurrency: number;
  latencyMs: number;
  tokensPerSecond: number;
  quality: number;
  faultWindows?: R20FaultWindow[];
  cooldownThreshold?: number;
  cooldownMs?: number;
  recoveryProbeSuccesses?: number;
}

export interface R20TaskProfile {
  taskType: R20TaskType;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  topology: R20Topology;
  role: string;
  weight?: number;
  cancellationRate?: number;
}

export interface R20ScaleScenario {
  scenarioId: string;
  evidenceClass: R20EvidenceClass;
  users: number;
  concurrentActiveUsers: number;
  tasksPerUser: number;
  tasksByUser?: Record<string, number>;
  thinkTimeMs: number;
  burst: boolean;
  maxRetries: number;
  backoffBaseMs: number;
  jitterRatio: number;
  maxQueueWaitMs: number;
  userConcurrency: number;
  taskMix: R20TaskProfile[];
  routes: R20SyntheticRouteConfig[];
  seed?: number;
  startedAt?: string;
  commit?: string;
}

export interface R20QueueEvent {
  atMs: number;
  state: R20QueueState;
  userId: string;
  sessionId: string;
  taskId: string;
  executionId: string;
  providerId?: string;
  routeId?: string;
  reason?: string;
  waitMs?: number;
}

export interface R20UserMetrics {
  userId: string;
  attemptedTasks: number;
  completedTasks: number;
  blockedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  averageWaitMs: number;
  maxWaitMs: number;
}

export interface R20ProviderMetrics {
  providerId: string;
  routeId: string;
  attempts: number;
  successes: number;
  failures: number;
  rateLimits: number;
  timeouts: number;
  tokens: number;
  busyMs: number;
  utilization: number;
  cooldowns: number;
}

export interface R20ScaleResult {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  commit: string;
  evidenceClass: R20EvidenceClass;
  scenario: string;
  users: number;
  concurrency: number;
  taskMix: Array<{ taskType: R20TaskType; topology: R20Topology; weight: number }>;
  providers: string[];
  routes: string[];
  durationMs: number;
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  rateLimits: number;
  timeouts: number;
  malformedResponses: number;
  connectionResets: number;
  queueDepthMax: number;
  queueWaitMs: { p50: number; p95: number; max: number };
  responseLatencyMs: { p50: number; p95: number; max: number };
  routeFailovers: number;
  routeExhaustions: number;
  tasks: { attempted: number; completed: number; blocked: number; failed: number; cancelled: number };
  tokensProcessed: number;
  userMetrics: R20UserMetrics[];
  providerMetrics: R20ProviderMetrics[];
  fairness: { jainIndex: number; starvationEvents: number; normalUserP95WaitMs: number };
  scheduler: { admissionDecisions: number; averageDecisionMicros: number; maxDecisionMicros: number };
  result: "PASS" | "DEGRADED" | "FAIL";
  events: R20QueueEvent[];
}

interface Execution {
  userId: string;
  sessionId: string;
  taskId: string;
  executionId: string;
  profile: R20TaskProfile;
  availableAt: number;
  queuedAt: number;
  attempt: number;
  routeIndex: number;
  state: R20QueueState;
  reservationId?: string;
}

interface ActiveExecution {
  execution: Execution;
  route: RouteState;
  startedAt: number;
  completesAt: number;
  outcome: R20FaultKind;
  latencyMs: number;
}

interface RouteState {
  config: R20SyntheticRouteConfig;
  active: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  recoverySuccesses: number;
  state: "healthy" | "degraded" | "cooldown" | "probing" | "unavailable";
  metrics: Omit<R20ProviderMetrics, "utilization">;
}

interface Reservation {
  reservationId: string;
  userId: string;
  taskId: string;
  executionId: string;
  routeId: string;
  leaseUntil: number;
}

const TOPOLOGY_FANOUT: Readonly<Record<R20Topology, number>> = { T0: 1, T1: 2, T2: 2, T3: 3, T4: 4, T5: 4 };

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function jain(values: number[]): number {
  if (values.length === 0) return 1;
  const sum = values.reduce((total, value) => total + value, 0);
  const squares = values.reduce((total, value) => total + value * value, 0);
  return squares === 0 ? 1 : (sum * sum) / (values.length * squares);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function topologyProfiles(profile: R20TaskProfile): R20TaskProfile[] {
  return Array.from({ length: TOPOLOGY_FANOUT[profile.topology] }, () => ({ ...profile, topology: "T0", turns: Math.max(1, Math.ceil(profile.turns / TOPOLOGY_FANOUT[profile.topology])) }));
}

export class R20SyntheticProviderEmulator {
  private readonly routes: RouteState[];

  constructor(configs: R20SyntheticRouteConfig[]) {
    this.routes = configs.map((config) => ({
      config,
      active: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      recoverySuccesses: 0,
      state: "healthy",
      metrics: { providerId: config.providerId, routeId: config.routeId, attempts: 0, successes: 0, failures: 0, rateLimits: 0, timeouts: 0, tokens: 0, busyMs: 0, cooldowns: 0 },
    }));
  }

  routeStates(): readonly RouteState[] {
    return this.routes;
  }

  eligible(role: string, now: number): RouteState[] {
    return this.routes.filter((route) => {
      if (route.config.costClass !== "PUBLIC_MANAGED_FREE") return false;
      if (!route.config.roles.includes(role)) return false;
      if (route.cooldownUntil > now) return false;
      if (route.state === "unavailable") return false;
      if (route.cooldownUntil > 0 && route.cooldownUntil <= now && route.state === "cooldown") route.state = "probing";
      return route.active < route.config.concurrency;
    });
  }

  dispatch(route: RouteState, execution: Execution, now: number): ActiveExecution {
    const fault = route.config.faultWindows?.find((window) => window.startMs <= now && now < window.endMs);
    const outcome = fault?.kind ?? "success";
    const throughputMs = Math.ceil(((execution.profile.inputTokens + execution.profile.outputTokens) / Math.max(1, route.config.tokensPerSecond)) * 1000);
    const latencyMs = fault?.latencyMs ?? (outcome === "latency_spike" ? route.config.latencyMs * 5 : route.config.latencyMs) + throughputMs;
    route.active++;
    route.metrics.attempts++;
    return { execution, route, startedAt: now, completesAt: now + latencyMs, outcome, latencyMs };
  }

  complete(active: ActiveExecution, now: number): void {
    const route = active.route;
    route.active = Math.max(0, route.active - 1);
    route.metrics.busyMs += active.latencyMs;
    if (active.outcome === "success" || active.outcome === "latency_spike") {
      route.metrics.successes++;
      route.metrics.tokens += active.execution.profile.inputTokens + active.execution.profile.outputTokens;
      route.consecutiveFailures = 0;
      if (route.state === "probing") {
        route.recoverySuccesses++;
        if (route.recoverySuccesses >= (route.config.recoveryProbeSuccesses ?? 2)) {
          route.state = "healthy";
          route.cooldownUntil = 0;
          route.recoverySuccesses = 0;
        }
      } else route.state = "healthy";
      return;
    }
    route.metrics.failures++;
    route.consecutiveFailures++;
    if (active.outcome === "rate_limit") route.metrics.rateLimits++;
    if (active.outcome === "timeout") route.metrics.timeouts++;
    const threshold = route.config.cooldownThreshold ?? 2;
    if (route.consecutiveFailures >= threshold || active.outcome === "offline" || active.outcome === "model_removed") {
      route.state = active.outcome === "model_removed" ? "unavailable" : "cooldown";
      route.cooldownUntil = active.outcome === "model_removed" ? Number.POSITIVE_INFINITY : now + (route.config.cooldownMs ?? 1_000);
      route.recoverySuccesses = 0;
      route.metrics.cooldowns++;
    } else route.state = "degraded";
  }
}

export class R20FairScheduler {
  private readonly queues = new Map<string, Execution[]>();
  private readonly order: string[] = [];
  private cursor = 0;
  private readonly activeByUser = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(private readonly userConcurrency: number) {}

  enqueue(execution: Execution): void {
    let queue = this.queues.get(execution.userId);
    if (!queue) {
      queue = [];
      this.queues.set(execution.userId, queue);
      this.order.push(execution.userId);
    }
    queue.push(execution);
  }

  depth(): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  }

  next(now: number): Execution | undefined {
    if (this.order.length === 0) return undefined;
    for (let checked = 0; checked < this.order.length; checked++) {
      const index = (this.cursor + checked) % this.order.length;
      const userId = this.order[index]!;
      const queue = this.queues.get(userId);
      if (!queue || queue.length === 0 || (this.activeByUser.get(userId) ?? 0) >= this.userConcurrency) continue;
      const eligibleIndex = queue.findIndex((item) => item.availableAt <= now);
      if (eligibleIndex < 0) continue;
      const [execution] = queue.splice(eligibleIndex, 1);
      this.cursor = (index + 1) % this.order.length;
      return execution;
    }
    return undefined;
  }

  reserve(execution: Execution, routeId: string, now: number, leaseMs: number): Reservation {
    const reservation: Reservation = { reservationId: `reservation-${execution.executionId}-${execution.attempt}`, userId: execution.userId, taskId: execution.taskId, executionId: execution.executionId, routeId, leaseUntil: now + leaseMs };
    this.reservations.set(reservation.reservationId, reservation);
    this.activeByUser.set(execution.userId, (this.activeByUser.get(execution.userId) ?? 0) + 1);
    execution.reservationId = reservation.reservationId;
    return reservation;
  }

  release(execution: Execution): boolean {
    if (!execution.reservationId || !this.reservations.delete(execution.reservationId)) return false;
    this.activeByUser.set(execution.userId, Math.max(0, (this.activeByUser.get(execution.userId) ?? 1) - 1));
    execution.reservationId = undefined;
    return true;
  }

  recoverExpired(now: number): number {
    let recovered = 0;
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.leaseUntil > now) continue;
      this.reservations.delete(reservation.reservationId);
      this.activeByUser.set(reservation.userId, Math.max(0, (this.activeByUser.get(reservation.userId) ?? 1) - 1));
      recovered++;
    }
    return recovered;
  }

  reservationCount(): number {
    return this.reservations.size;
  }
}

export class R20ScaleHarness {
  run(scenario: R20ScaleScenario): R20ScaleResult {
    if (scenario.evidenceClass !== "simulated" && scenario.evidenceClass !== "locally_emulated") throw new Error("Synthetic harness results must be classified as simulated or locally_emulated");
    if (scenario.users < 1 || scenario.concurrentActiveUsers < 1 || scenario.taskMix.length === 0 || scenario.routes.length === 0) throw new Error("Scenario requires users, active users, task mix, and routes");
    const random = seeded(scenario.seed ?? 20);
    const emulator = new R20SyntheticProviderEmulator(scenario.routes);
    const scheduler = new R20FairScheduler(scenario.userConcurrency);
    const events: R20QueueEvent[] = [];
    const active: ActiveExecution[] = [];
    const waits: number[] = [];
    const latencies: number[] = [];
    const userWaits = new Map<string, number[]>();
    const taskState = new Map<string, { pending: number; failed: number; cancelled: number; completed: number }>();
    let now = 0;
    let requests = 0;
    let retries = 0;
    let rateLimits = 0;
    let timeouts = 0;
    let malformedResponses = 0;
    let connectionResets = 0;
    let routeFailovers = 0;
    let routeExhaustions = 0;
    let queueDepthMax = 0;
    let admissionDecisions = 0;
    let decisionMicrosTotal = 0;
    let decisionMicrosMax = 0;
    const profiles = this.weightedProfiles(scenario.taskMix);
    const activeUsers = Math.min(scenario.users, scenario.concurrentActiveUsers);

    for (let userIndex = 0; userIndex < scenario.users; userIndex++) {
      const userId = `user-${String(userIndex + 1).padStart(4, "0")}`;
      const sessionId = `session-${userId}`;
      const userTaskCount = scenario.tasksByUser?.[userId] ?? scenario.tasksPerUser;
      for (let taskIndex = 0; taskIndex < userTaskCount; taskIndex++) {
        const profile = profiles[Math.floor(random() * profiles.length)]!;
        const taskId = `task-${userId}-${taskIndex + 1}`;
        const executions = topologyProfiles(profile);
        taskState.set(taskId, { pending: executions.length, failed: 0, cancelled: 0, completed: 0 });
        executions.forEach((executionProfile, executionIndex) => {
          const availableAt = scenario.burst ? Math.floor(userIndex / activeUsers) * scenario.thinkTimeMs : (userIndex % activeUsers) * scenario.thinkTimeMs + taskIndex * scenario.thinkTimeMs;
          const execution: Execution = { userId, sessionId, taskId, executionId: `${taskId}-exec-${executionIndex + 1}`, profile: executionProfile, availableAt, queuedAt: availableAt, attempt: 0, routeIndex: 0, state: "queued" };
          scheduler.enqueue(execution);
          events.push(this.event(availableAt, execution, "queued"));
        });
      }
    }

    const maxIterations = Math.max(100_000, scenario.users * scenario.tasksPerUser * 1_000);
    for (let iteration = 0; iteration < maxIterations && (scheduler.depth() > 0 || active.length > 0); iteration++) {
      scheduler.recoverExpired(now);
      active.sort((left, right) => left.completesAt - right.completesAt);
      while (active[0] && active[0].completesAt <= now) {
        const completed = active.shift()!;
        emulator.complete(completed, now);
        scheduler.release(completed.execution);
        requests++;
        latencies.push(completed.latencyMs);
        this.handleCompletion(completed, scenario, scheduler, events, taskState, now, random, {
          retry: () => { retries++; },
          rateLimit: () => { rateLimits++; },
          timeout: () => { timeouts++; },
          malformed: () => { malformedResponses++; },
          reset: () => { connectionResets++; },
          failover: () => { routeFailovers++; },
        });
      }

      let dispatched = false;
      for (;;) {
        const decisionStart = process.hrtime.bigint();
        const execution = scheduler.next(now);
        const decisionMicros = Number(process.hrtime.bigint() - decisionStart) / 1_000;
        admissionDecisions++;
        decisionMicrosTotal += decisionMicros;
        decisionMicrosMax = Math.max(decisionMicrosMax, decisionMicros);
        if (!execution) break;
        if (now - execution.queuedAt > scenario.maxQueueWaitMs) {
          execution.state = "capacity_exhausted";
          routeExhaustions++;
          taskState.get(execution.taskId)!.failed++;
          taskState.get(execution.taskId)!.pending--;
          events.push(this.event(now, execution, "capacity_exhausted", undefined, "MAX_QUEUE_WAIT_EXCEEDED"));
          continue;
        }
        const routes = emulator.eligible(execution.profile.role, now);
        const route = routes[execution.routeIndex % Math.max(1, routes.length)];
        if (!route) {
          execution.state = "waiting_for_capacity";
          execution.availableAt = now + 1;
          scheduler.enqueue(execution);
          events.push(this.event(now, execution, "waiting_for_capacity", undefined, "NO_AVAILABLE_SLOT"));
          break;
        }
        execution.state = "reserving_route";
        events.push(this.event(now, execution, "reserving_route", route));
        scheduler.reserve(execution, route.config.routeId, now, Math.max(1_000, route.config.latencyMs * 10));
        const waitMs = now - execution.queuedAt;
        waits.push(waitMs);
        const perUser = userWaits.get(execution.userId) ?? [];
        perUser.push(waitMs);
        userWaits.set(execution.userId, perUser);
        execution.state = "dispatching";
        events.push(this.event(now, execution, "dispatching", route, undefined, waitMs));
        active.push(emulator.dispatch(route, execution, now));
        dispatched = true;
      }
      queueDepthMax = Math.max(queueDepthMax, scheduler.depth());
      const nextCompletion = active.reduce((minimum, item) => Math.min(minimum, item.completesAt), Number.POSITIVE_INFINITY);
      const nextAvailable = this.nextQueueTime(scheduler, now);
      const next = Math.min(nextCompletion, nextAvailable);
      if (!Number.isFinite(next)) break;
      now = Math.max(now + (dispatched ? 0 : 1), next);
    }

    const users = this.userMetrics(scenario.users, taskState, userWaits);
    const tasks = this.taskTotals(taskState);
    const providerMetrics = emulator.routeStates().map((route) => ({ ...route.metrics, utilization: now === 0 ? 0 : Math.min(1, route.metrics.busyMs / (now * route.config.concurrency)) }));
    const completedValues = users.map((user) => user.attemptedTasks === 0 ? 1 : user.completedTasks / user.attemptedTasks);
    const starvationEvents = users.filter((user) => user.attemptedTasks > 0 && user.completedTasks === 0).length;
    const failures = providerMetrics.reduce((sum, route) => sum + route.failures, 0);
    return {
      schemaVersion: 1,
      runId: `r20-${scenario.scenarioId}-${crypto.createHash("sha256").update(JSON.stringify(scenario)).digest("hex").slice(0, 12)}`,
      timestamp: scenario.startedAt ?? new Date().toISOString(),
      commit: scenario.commit ?? "unknown",
      evidenceClass: scenario.evidenceClass,
      scenario: scenario.scenarioId,
      users: scenario.users,
      concurrency: scenario.concurrentActiveUsers,
      taskMix: scenario.taskMix.map((profile) => ({ taskType: profile.taskType, topology: profile.topology, weight: profile.weight ?? 1 })),
      providers: [...new Set(scenario.routes.map((route) => route.providerId))],
      routes: scenario.routes.map((route) => route.routeId),
      durationMs: now,
      requests,
      successes: providerMetrics.reduce((sum, route) => sum + route.successes, 0),
      failures,
      retries,
      rateLimits,
      timeouts,
      malformedResponses,
      connectionResets,
      queueDepthMax,
      queueWaitMs: { p50: percentile(waits, 0.5), p95: percentile(waits, 0.95), max: Math.max(0, ...waits) },
      responseLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(0, ...latencies) },
      routeFailovers,
      routeExhaustions,
      tasks,
      tokensProcessed: providerMetrics.reduce((sum, route) => sum + route.tokens, 0),
      userMetrics: users,
      providerMetrics,
      fairness: { jainIndex: jain(completedValues), starvationEvents, normalUserP95WaitMs: percentile(users.slice(1).flatMap((user) => userWaits.get(user.userId) ?? []), 0.95) },
      scheduler: { admissionDecisions, averageDecisionMicros: admissionDecisions === 0 ? 0 : decisionMicrosTotal / admissionDecisions, maxDecisionMicros: decisionMicrosMax },
      result: starvationEvents > 0 || tasks.failed > 0 ? "FAIL" : failures > 0 || retries > 0 ? "DEGRADED" : "PASS",
      events,
    };
  }

  private weightedProfiles(profiles: R20TaskProfile[]): R20TaskProfile[] {
    return profiles.flatMap((profile) => Array.from({ length: Math.max(1, Math.round(profile.weight ?? 1)) }, () => profile));
  }

  private event(atMs: number, execution: Execution, state: R20QueueState, route?: RouteState, reason?: string, waitMs?: number): R20QueueEvent {
    return { atMs, state, userId: execution.userId, sessionId: execution.sessionId, taskId: execution.taskId, executionId: execution.executionId, ...(route ? { providerId: route.config.providerId, routeId: route.config.routeId } : {}), ...(reason ? { reason } : {}), ...(waitMs !== undefined ? { waitMs } : {}) };
  }

  private nextQueueTime(_scheduler: R20FairScheduler, now: number): number {
    return now + 1;
  }

  private handleCompletion(active: ActiveExecution, scenario: R20ScaleScenario, scheduler: R20FairScheduler, events: R20QueueEvent[], tasks: Map<string, { pending: number; failed: number; cancelled: number; completed: number }>, now: number, random: () => number, counters: { retry(): void; rateLimit(): void; timeout(): void; malformed(): void; reset(): void; failover(): void }): void {
    const execution = active.execution;
    const task = tasks.get(execution.taskId)!;
    if ((execution.profile.cancellationRate ?? 0) > random()) {
      task.cancelled++;
      task.pending--;
      events.push(this.event(now, execution, "cancelled", active.route));
      return;
    }
    if (active.outcome === "success" || active.outcome === "latency_spike") {
      task.completed++;
      task.pending--;
      events.push(this.event(now, execution, "completed", active.route));
      return;
    }
    if (active.outcome === "rate_limit") counters.rateLimit();
    if (active.outcome === "timeout") counters.timeout();
    if (active.outcome === "malformed") counters.malformed();
    if (active.outcome === "connection_reset") counters.reset();
    if (execution.attempt < scenario.maxRetries) {
      execution.attempt++;
      execution.routeIndex++;
      const exponential = scenario.backoffBaseMs * 2 ** (execution.attempt - 1);
      const jitter = exponential * scenario.jitterRatio * random();
      execution.availableAt = now + Math.round(exponential + jitter);
      execution.queuedAt = now;
      execution.state = execution.routeIndex > 0 ? "failover" : "retrying_route";
      counters.retry();
      counters.failover();
      events.push(this.event(now, execution, execution.state, active.route, active.outcome));
      scheduler.enqueue(execution);
      return;
    }
    task.failed++;
    task.pending--;
    events.push(this.event(now, execution, "failed", active.route, active.outcome));
  }

  private userMetrics(userCount: number, tasks: Map<string, { pending: number; failed: number; cancelled: number; completed: number }>, waits: Map<string, number[]>): R20UserMetrics[] {
    return Array.from({ length: userCount }, (_, index) => {
      const userId = `user-${String(index + 1).padStart(4, "0")}`;
      const owned = [...tasks.entries()].filter(([taskId]) => taskId.startsWith(`task-${userId}-`)).map(([, value]) => value);
      const userWaits = waits.get(userId) ?? [];
      return {
        userId,
        attemptedTasks: owned.length,
        completedTasks: owned.filter((task) => task.pending === 0 && task.failed === 0 && task.cancelled === 0).length,
        blockedTasks: owned.filter((task) => task.pending > 0).length,
        failedTasks: owned.filter((task) => task.failed > 0).length,
        cancelledTasks: owned.filter((task) => task.cancelled > 0).length,
        averageWaitMs: userWaits.length === 0 ? 0 : userWaits.reduce((sum, value) => sum + value, 0) / userWaits.length,
        maxWaitMs: Math.max(0, ...userWaits),
      };
    });
  }

  private taskTotals(tasks: Map<string, { pending: number; failed: number; cancelled: number; completed: number }>): R20ScaleResult["tasks"] {
    const values = [...tasks.values()];
    return {
      attempted: values.length,
      completed: values.filter((task) => task.pending === 0 && task.failed === 0 && task.cancelled === 0).length,
      blocked: values.filter((task) => task.pending > 0).length,
      failed: values.filter((task) => task.failed > 0).length,
      cancelled: values.filter((task) => task.cancelled > 0).length,
    };
  }
}

export interface R20DauAssumptions {
  dau: number;
  peakHourActivePercent: number;
  tasksPerUserDay: number;
  turnsPerTask: number;
  averageTaskMinutes: number;
  subagentPercent: number;
  browserPercent: number;
  averageTokensPerTurn: number;
  burstFactor: number;
}

export interface R20DauModel {
  assumptions: R20DauAssumptions;
  peakActiveUsers: number;
  peakConcurrentTasks: number;
  dailyTasks: number;
  dailyTurns: number;
  dailyTokens: number;
  peakRequestMultiplier: number;
}

export function modelR20Dau(assumptions: R20DauAssumptions): R20DauModel {
  const peakActiveUsers = Math.ceil(assumptions.dau * assumptions.peakHourActivePercent);
  const dailyTasks = assumptions.dau * assumptions.tasksPerUserDay;
  const dailyTurns = dailyTasks * assumptions.turnsPerTask;
  const peakConcurrentTasks = Math.ceil(peakActiveUsers * Math.min(1, assumptions.averageTaskMinutes / 60) * assumptions.burstFactor);
  const peakRequestMultiplier = 1 + assumptions.subagentPercent * 3 + assumptions.browserPercent;
  return { assumptions, peakActiveUsers, peakConcurrentTasks, dailyTasks, dailyTurns, dailyTokens: dailyTurns * assumptions.averageTokensPerTurn, peakRequestMultiplier };
}
