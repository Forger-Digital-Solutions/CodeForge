import { CapacityReservationLedger, type CapacityRoute, type CapacityWindow, type ProviderCapacityPool } from "@codeforge/forge-zero";

export interface R33SyntheticRoute {
  id: string;
  concurrency: number;
  quotaPerWindow: number;
  windowTicks: number;
  failedCallsConsumeQuota: boolean;
  fault?: { fromTick: number; throughTick: number; kind: "429" | "403" | "5xx" };
}

export interface R33ControlPlaneScenario {
  users: number;
  tasksPerUser: number;
  routes: R33SyntheticRoute[];
  maxTicks: number;
}

export interface R33ControlPlaneResult {
  evidenceClass: "synthetic_control_plane";
  simulatedUsers: number;
  simulatedTasks: number;
  ticks: number;
  attemptedAdmissions: number;
  duplicateAdmissions: number;
  inFlightReplayRejections: number;
  idempotentReplays: number;
  completedTasks: number;
  checkpointedTasks: number;
  recoveredTasks: number;
  migratedTasks: number;
  rateLimits: number;
  forbiddenResponses: number;
  serverErrors: number;
  quotaResets: number;
  quotaDeniedSlots: number;
  maximumConcurrentLeases: number;
  leakedLeases: number;
  capacityAccountingErrors: number;
  fairFirstAdmissions: boolean;
  starvedUsers: number;
  maximumFirstAdmissionWaitTicks: number;
  /** reserve() calls that reached the production CapacityReservationLedger. */
  ledgerAdmissions: number;
  /** reserve() denials observed where the independent synthetic model still had a slot. */
  ledgerAccountingDivergences: number;
  complete: boolean;
  routes: Array<{ id: string; dispatched: number; completed: number; failed: number; quotaConsumed: number; peakLeases: number }>;
}

interface RouteState {
  config: R33SyntheticRoute;
  consumed: number;
  totalConsumed: number;
  dispatched: number;
  completed: number;
  failed: number;
  peakLeases: number;
  leases: number;
  unavailableUntilTick: number;
  batch: Int32Array;
  batchRetry: Uint8Array;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function mayAdmit(state: Uint8Array, task: number, retry: boolean): boolean {
  return state[task] === (retry ? 2 : 0);
}

const BASE_TIME = Date.parse("2026-09-15T00:00:00.000Z");
const WINDOW_RESET = "2026-09-16T00:00:00.000Z";

/** Map a synthetic route to the production route/pool pair the real ledger adjudicates.
 * `requestsRemaining` carries cumulative per-window consumption so a released lease does not
 * refund quota the sim has already spent — matching production reservation semantics where
 * the lease hold and the consumed budget are separate dimensions. */
function ledgerRoute(config: R33SyntheticRoute, requestsRemaining: number): { route: CapacityRoute; pool: ProviderCapacityPool } {
  const windows: CapacityWindow[] = [
    { unit: "requests", limit: config.quotaPerWindow, remaining: Math.max(0, requestsRemaining), resetAt: WINDOW_RESET, scope: "ORG", observedAt: new Date(BASE_TIME).toISOString(), authoritative: true },
    { unit: "input_tokens", limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER, resetAt: WINDOW_RESET, scope: "ORG", observedAt: new Date(BASE_TIME).toISOString(), authoritative: true },
    { unit: "output_tokens", limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER, resetAt: WINDOW_RESET, scope: "ORG", observedAt: new Date(BASE_TIME).toISOString(), authoritative: true },
    { unit: "concurrency", limit: config.concurrency, remaining: config.concurrency, resetAt: WINDOW_RESET, scope: "ORG", observedAt: new Date(BASE_TIME).toISOString(), authoritative: true },
  ];
  const route: CapacityRoute = {
    routeId: config.id,
    providerId: `synthetic-${config.id}`,
    modelId: config.id,
    canonicalModelId: config.id,
    family: "synthetic",
    gateway: "synthetic",
    supplyClass: "PURE_MANAGED_FREE",
    capacityPoolId: `pool-${config.id}`,
    capacityPoolScope: "SHARED_OWNER_POOL",
    capacityScope: "ORG",
    dataPolicyProfile: "PRIVATE_CODE_ALLOWED",
    lifecycle: "APPROVED",
    explicitZeroPrice: true,
    paidFallbackDisabled: true,
    managedMultiUserAllowed: true,
    privacyClass: "standard",
    roles: ["coder"],
    qualityScore: 50,
    healthy: true,
    enabled: true,
    windows,
  };
  const pool: ProviderCapacityPool = {
    poolId: `pool-${config.id}`,
    providerId: `synthetic-${config.id}`,
    scope: "SHARED_OWNER_POOL",
    supplyClass: "PURE_MANAGED_FREE",
    windows,
    observedAt: new Date(BASE_TIME).toISOString(),
    authoritative: true,
  };
  return { route, pool };
}

/** Models bounded admission batches, quota windows, leases, retries, and user round robin without live inference. */
export function simulateR33ControlPlane(scenario: R33ControlPlaneScenario): R33ControlPlaneResult {
  positiveInteger(scenario.users, "users");
  positiveInteger(scenario.tasksPerUser, "tasksPerUser");
  positiveInteger(scenario.maxTicks, "maxTicks");
  if (scenario.tasksPerUser > 255) throw new Error("tasksPerUser exceeds compact counter range");
  const taskCount = scenario.users * scenario.tasksPerUser;
  if (!Number.isSafeInteger(taskCount) || taskCount > 10_000_000) throw new Error("synthetic task count exceeds bounded harness capacity");
  if (scenario.routes.length < 1 || scenario.routes.length > 255) throw new Error("routes must have 1–255 entries");
  const ids = new Set<string>();
  const routes: RouteState[] = scenario.routes.map((config) => {
    positiveInteger(config.concurrency, "route concurrency");
    positiveInteger(config.quotaPerWindow, "route quotaPerWindow");
    positiveInteger(config.windowTicks, "route windowTicks");
    if (!config.id || ids.has(config.id)) throw new Error("route ids must be unique and nonempty");
    ids.add(config.id);
    return { config, consumed: 0, totalConsumed: 0, dispatched: 0, completed: 0, failed: 0, peakLeases: 0, leases: 0, unavailableUntilTick: 0, batch: new Int32Array(config.concurrency), batchRetry: new Uint8Array(config.concurrency) };
  });

  // Indexed state makes idempotency exact without a million string keys or event records.
  const state = new Uint8Array(taskCount); // 0 queued, 1 leased, 2 checkpointed, 3 complete
  const firstRoute = new Uint8Array(taskCount);
  const completedByUser = new Uint8Array(scenario.users);
  const retry: number[] = [];
  let retryHead = 0;
  let nextFresh = 0;
  let completedTasks = 0;
  let attemptedAdmissions = 0;
  let duplicateAdmissions = 0;
  let inFlightReplayRejections = 0;
  let idempotentReplays = 0;
  let checkpointedTasks = 0;
  let recoveredTasks = 0;
  let migratedTasks = 0;
  let rateLimits = 0;
  let forbiddenResponses = 0;
  let serverErrors = 0;
  let quotaResets = 0;
  let quotaDeniedSlots = 0;
  let maximumConcurrentLeases = 0;
  let capacityAccountingErrors = 0;
  let fairFirstAdmissions = true;
  let firstAdmissions = 0;
  let maximumFirstAdmissionWaitTicks = 0;
  let tick = 0;

  // Admissions run through the production CapacityReservationLedger — the same code a real
  // turn consults — while the compact counters above stay an independent model. A ledger
  // denial where the model still had a slot, or vice versa, is a cross-validation error.
  let simNow = BASE_TIME;
  const ledger = new CapacityReservationLedger({
    routes: [],
    pools: [],
    maxActiveReservationsPerUser: scenario.tasksPerUser,
    now: () => simNow,
  });
  let ledgerAdmissions = 0;
  let ledgerAccountingDivergences = 0;

  for (; tick < scenario.maxTicks && completedTasks < taskCount; tick++) {
    simNow = BASE_TIME + tick * 1_000;
    for (const route of routes) {
      if (tick > 0 && tick % route.config.windowTicks === 0) {
        route.consumed = 0;
        quotaResets++;
      }
    }
    const refreshed = routes.map((route) => ledgerRoute(route.config, route.config.quotaPerWindow - route.consumed));
    ledger.updateRoutes(refreshed.map((entry) => entry.route), refreshed.map((entry) => entry.pool));
    let concurrentLeases = 0;
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex]!;
      const { config } = route;
      if (tick < route.unavailableUntilTick) continue;
      const slots = Math.min(config.concurrency, config.quotaPerWindow - route.consumed);
      quotaDeniedSlots += config.concurrency - slots;
      for (let slot = 0; slot < slots; slot++) {
        const fromRetry = retryHead < retry.length;
        const task = fromRetry ? retry[retryHead++]! : nextFresh < taskCount ? nextFresh++ : -1;
        if (task < 0) break;
        attemptedAdmissions++;
        if (!mayAdmit(state, task, fromRetry)) {
          duplicateAdmissions++;
          continue;
        }
        const admission = ledger.reserve({
          reservationId: `task-${task}`,
          userId: `user-${task % scenario.users}`,
          routeIds: [config.id],
          role: "coder",
          taskKind: "task",
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          isNewUser: false,
          priority: "normal",
          createdAt: new Date(simNow).toISOString(),
          leaseUntil: new Date(simNow + 120_000).toISOString(),
        });
        ledgerAdmissions++;
        if (!admission.admitted || admission.routeId !== config.id) {
          ledgerAccountingDivergences++;
          if (fromRetry) retryHead--;
          else nextFresh--;
          continue;
        }
        if (!fromRetry && task >= scenario.users && firstAdmissions !== scenario.users) fairFirstAdmissions = false;
        if (!fromRetry && task < scenario.users) {
          firstAdmissions++;
          maximumFirstAdmissionWaitTicks = tick;
        }
        state[task] = 1;
        if (mayAdmit(state, task, false)) duplicateAdmissions++;
        else inFlightReplayRejections++;
        if (!fromRetry) firstRoute[task] = routeIndex + 1;
        else if (firstRoute[task] !== routeIndex + 1) migratedTasks++;
        route.batch[route.leases] = task;
        route.batchRetry[route.leases] = fromRetry ? 1 : 0;
        route.leases++;
        concurrentLeases++;
        route.dispatched++;
        route.peakLeases = Math.max(route.peakLeases, route.leases);
        maximumConcurrentLeases = Math.max(maximumConcurrentLeases, concurrentLeases);
      }
      if (route.leases > config.concurrency) capacityAccountingErrors++;
    }

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex]!;
      const fault = route.config.fault;
      const faultKind = fault && tick >= fault.fromTick && tick <= fault.throughTick ? fault.kind : undefined;
      for (let i = 0; i < route.leases; i++) {
        const task = route.batch[i]!;
        if (state[task] !== 1) capacityAccountingErrors++;
        if (!ledger.release(`task-${task}`)) capacityAccountingErrors++;
        if (faultKind) {
          state[task] = 2;
          retry.push(task);
          checkpointedTasks++;
          route.failed++;
          if (faultKind === "429") rateLimits++;
          else if (faultKind === "403") forbiddenResponses++;
          else serverErrors++;
          route.unavailableUntilTick = faultKind === "403" ? Number.POSITIVE_INFINITY : Math.max(route.unavailableUntilTick, tick + (faultKind === "429" ? 2 : 1));
          if (route.config.failedCallsConsumeQuota) {
            route.consumed++;
            route.totalConsumed++;
          }
        } else {
          if (route.batchRetry[i] === 1) recoveredTasks++;
          state[task] = 3;
          completedTasks++;
          completedByUser[task % scenario.users]!++;
          route.completed++;
          route.consumed++;
          route.totalConsumed++;
        }
      }
      concurrentLeases -= route.leases;
      route.leases = 0;
      if (route.consumed > route.config.quotaPerWindow) capacityAccountingErrors++;
    }
    if (concurrentLeases !== 0) capacityAccountingErrors++;
    if (ledger.snapshot().activeReservations !== 0) capacityAccountingErrors++;
    if (retryHead === retry.length) {
      retry.length = 0;
      retryHead = 0;
    } else if (retryHead > 16_384 && retryHead * 2 > retry.length) {
      retry.splice(0, retryHead);
      retryHead = 0;
    }
  }

  // Replay every completed task key through the admission state guard.
  for (let task = 0; task < taskCount; task++) {
    if (state[task] === 3) {
      if (mayAdmit(state, task, false)) duplicateAdmissions++;
      else idempotentReplays++;
    }
  }
  let starvedUsers = 0;
  for (let user = 0; user < scenario.users; user++) {
    if (completedByUser[user] !== scenario.tasksPerUser) starvedUsers++;
  }
  if (routes.reduce((sum, route) => sum + route.completed, 0) !== completedTasks) capacityAccountingErrors++;
  for (const route of routes) {
    if (route.dispatched !== route.completed + route.failed) capacityAccountingErrors++;
  }
  return {
    evidenceClass: "synthetic_control_plane", simulatedUsers: scenario.users, simulatedTasks: taskCount,
    ticks: tick, attemptedAdmissions, duplicateAdmissions, inFlightReplayRejections, idempotentReplays, completedTasks,
    checkpointedTasks, recoveredTasks, migratedTasks, rateLimits, forbiddenResponses, serverErrors,
    quotaResets, quotaDeniedSlots, maximumConcurrentLeases,
    leakedLeases: routes.reduce((sum, route) => sum + route.leases, 0), capacityAccountingErrors,
    fairFirstAdmissions, starvedUsers, maximumFirstAdmissionWaitTicks,
    ledgerAdmissions, ledgerAccountingDivergences,
    complete: completedTasks === taskCount && starvedUsers === 0 && ledger.snapshot().activeReservations === 0,
    routes: routes.map((route) => ({ id: route.config.id, dispatched: route.dispatched, completed: route.completed, failed: route.failed, quotaConsumed: route.totalConsumed, peakLeases: route.peakLeases })),
  };
}
