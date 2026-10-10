import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatRequest, Usage } from "@codeforge/providers";
import { ProviderError } from "@codeforge/providers";
import type { CapacityWindow, FreeAdmissionReceipt, QuotaScopeEvidence } from "@codeforge/forge-zero";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";

export type PersonalRoutingMode = "FREE_ONLY" | "FREE_PREFERRED" | "PAID_PREFERRED" | "SPECIFIC_ACCOUNT" | "AUTO_BEST";

export interface PersonalRoutingPolicy {
  mode: PersonalRoutingMode;
  paidEnabled: boolean;
  explicitConsent: boolean;
  limitationsAcknowledged: boolean;
  specificConnectionId?: string;
}

export interface PersonalAccountModelPrice {
  modelId: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  currency: "USD";
  confidence: "AUTHORITATIVE";
  source: string;
  verifiedAt: string;
  recheckAt: string;
  tokenOnly: boolean;
}

export interface PersonalAccountAuthority {
  ownerUserId: string;
  connectionId: string;
  providerId: string;
  credentialRef: string;
  credentialFingerprint?: string;
  accountClass: "FREE_VERIFIED" | "PAID" | "PROMOTIONAL" | "UNKNOWN" | "REVOKED";
  accountIdentityHash?: string;
  quotaDomainId: string;
  quotaScopeVerified: boolean;
  enabled: boolean;
  paidSpendingEnabled: boolean;
  preference?: "AUTO" | "PREFERRED" | "FALLBACK" | "MANUAL";
  authorizedWorkspacePath?: string;
  monthlyBudgetCents?: number;
  verifiedAt?: string;
  recheckAt?: string;
  expiresAt?: string;
  authState: string;
  freeAdmissionVerified?: boolean;
  admissionEvidence?: Omit<FreeAdmissionReceipt, "qualificationAt">;
  modelPricing?: readonly PersonalAccountModelPrice[];
  capacityWindows?: readonly CapacityWindow[];
  quotaScopeEvidence?: QuotaScopeEvidence;
}

export interface PersonalAccountBinding {
  ownerUserId: string;
  connectionId: string;
  canonicalProviderId: string;
  credentialRef: string;
  modelId: string;
  pricing: { inputCostPerMillion: number | null; outputCostPerMillion: number | null; currency: "USD"; confidence: string; source?: string };
}

export interface PersonalAccountPolicyOptions {
  personalAccountAuthority?: (ownerUserId: string, connectionId: string) => PersonalAccountAuthority | undefined;
  personalRoutingPolicy?: (ownerUserId: string) => PersonalRoutingPolicy | undefined;
  onEstimate?: (estimate: PersonalAccountEstimate) => Promise<void>;
  now?: () => number;
}

export interface PersonalAccountEstimate {
  ownerUserId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  requestId: string;
  estimatedCostUsd: number;
  remainingBudgetUsd: number;
  currency: "USD";
  pricingSource: string;
  workspacePath?: string;
  sessionId?: string;
  runId?: string;
  purpose: "INFERENCE" | "QUALIFICATION";
}

export class PersonalAccountPolicyError extends ProviderError {
  constructor(code: string) { super(code, code, false); }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw new PersonalAccountPolicyError(code); }
const current = (verifiedAt: string | undefined, recheckAt: string | undefined, now: number): boolean => !!verifiedAt && !!recheckAt && Number.isFinite(Date.parse(verifiedAt)) && Date.parse(verifiedAt) <= now && Number.isFinite(Date.parse(recheckAt)) && Date.parse(recheckAt) > now;
const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const modes = new Set<PersonalRoutingMode>(["FREE_ONLY", "FREE_PREFERRED", "PAID_PREFERRED", "SPECIFIC_ACCOUNT", "AUTO_BEST"]);

export function personalAccountDomain(authority: PersonalAccountAuthority): string {
  return authority.quotaScopeVerified && bounded(authority.quotaDomainId)
    ? (authority.quotaDomainId.startsWith(`${authority.providerId}:`) ? authority.quotaDomainId : `${authority.providerId}:${authority.quotaDomainId}`)
    : `${authority.providerId}:shared:unverified-account`;
}

interface Admission {
  authority: PersonalAccountAuthority;
  price: PersonalAccountModelPrice;
  free: boolean;
  estimatedMicros: number;
  budgetMicros: number;
}

interface StoredAttempt {
  ownerUserId: string;
  guardInstanceId: string;
  connectionId: string;
  requestId: string;
  requestDigest: string;
  domainId: string;
  budgetId: string;
  estimatedMicros: number;
  chargedMicros?: number;
  actualMicros?: number;
  reportedCostUsd?: number;
  accountingUncertain?: boolean;
  estimatePresentedAt?: string;
  status: "RESERVED" | "DISPATCHED" | "SETTLED" | "RELEASED" | "RECONCILED_UNCERTAIN";
  price: PersonalAccountModelPrice;
}

interface StoredBudget { consumedMicros: number; reservedMicros: number; unexpectedCharge?: boolean; }
interface StoredDomain { inFlight?: string; cooldownUntil?: number; accountingUncertain?: boolean; }

export interface PersonalAccountReservation {
  dispatch(): Promise<void>;
  settle(usage?: Usage): Promise<void>;
  fail(error?: unknown, usage?: Usage): Promise<void>;
}

/** Host certificates authorize spend; user-source metadata cannot certify itself. */
export class PersonalAccountBudgetGuard {
  private readonly now: () => number;
  private readonly guardInstanceId = randomUUID();
  private readonly activeOwners = new Set<string>();
  private leaseHeartbeat?: ReturnType<typeof setInterval>;
  private readonly leaseMs = 30_000;
  private readonly budgets = new Map<string, StoredBudget>();
  private readonly domains = new Map<string, StoredDomain>();
  constructor(private readonly persistence: ISessionPersistence, private readonly options: PersonalAccountPolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  authority(binding: PersonalAccountBinding): PersonalAccountAuthority | undefined {
    return this.options.personalAccountAuthority?.(binding.ownerUserId, binding.connectionId);
  }

  eligible(binding: PersonalAccountBinding): boolean {
    return this.classification(binding) !== undefined;
  }

  classification(binding: PersonalAccountBinding): "FREE_VERIFIED" | "PAID_AUTHORIZED" | undefined {
    try {
      const admission = this.admission(binding);
      const domain = this.domains.get(`personal-account-domain-${sha(personalAccountDomain(admission.authority))}`);
      if (domain?.accountingUncertain) return undefined;
      if ((domain?.cooldownUntil ?? 0) > this.now()) return undefined;
      const budget = this.budgets.get(this.budgetId(binding));
      if (budget?.unexpectedCharge) return undefined;
      if (!admission.free && budget && admission.price.inputCostPerMillion + admission.price.outputCostPerMillion > 0 && budget.consumedMicros + budget.reservedMicros >= admission.budgetMicros) return undefined;
      return admission.free ? "FREE_VERIFIED" : "PAID_AUTHORIZED";
    } catch { return undefined; }
  }

  assertCurrent(binding: PersonalAccountBinding, request: ChatRequest, credential: string): void {
    const admission = this.admission(binding, request, credential);
    const domain = this.domains.get(`personal-account-domain-${sha(personalAccountDomain(admission.authority))}`);
    if (domain?.accountingUncertain) fail("PERSONAL_ACCOUNT_DOMAIN_ACCOUNTING_UNCERTAIN");
  }

  async hydrateOwner(ownerUserId: string): Promise<void> {
    await this.touchGuardLease(ownerUserId);
    for (const item of await this.persistence.getWorkItemsByKind("personal_account_domain")) {
      const stored = item as unknown as { domain?: StoredDomain };
      if (stored.domain) this.domains.set(item.id, { ...stored.domain });
    }
    for (const item of await this.persistence.getWorkItemsByKind("personal_account_budget")) {
      const stored = item as unknown as { ownerUserId?: string; budget?: StoredBudget };
      if (stored.ownerUserId === ownerUserId && stored.budget) this.budgets.set(item.id, { ...stored.budget });
    }
    await this.reconcileOrphanedAttempts(ownerUserId);
  }

  private async touchGuardLease(ownerUserId: string): Promise<void> {
    this.activeOwners.add(ownerUserId);
    const leaseId = `personal-account-guard-${sha(`${ownerUserId}\0${this.guardInstanceId}`)}`;
    await this.persistence.withTransaction(async tx => {
      await tx.insertIfAbsent({ id: leaseId, kind: "personal_account_guard_lease", ownerUserId, guardInstanceId: this.guardInstanceId } as unknown as WorkItem);
      await tx.lockWorkItem(leaseId);
      await tx.upsertWorkItem({ id: leaseId, kind: "personal_account_guard_lease", ownerUserId, guardInstanceId: this.guardInstanceId,
        expiresAt: new Date(this.now() + this.leaseMs).toISOString() } as unknown as WorkItem);
    });
    this.leaseHeartbeat ??= setInterval(() => {
      for (const activeOwner of this.activeOwners) void this.touchGuardLease(activeOwner).catch(() => {});
    }, this.leaseMs / 3);
    this.leaseHeartbeat.unref?.();
  }

  private async reconcileOrphanedAttempts(ownerUserId: string): Promise<void> {
    const leases = await this.persistence.getWorkItemsByKind("personal_account_guard_lease");
    const liveInstances = new Set(leases.flatMap(item => {
      const lease = item as unknown as { ownerUserId?: string; guardInstanceId?: string; expiresAt?: string };
      return lease.ownerUserId === ownerUserId && lease.guardInstanceId && Number.isFinite(Date.parse(lease.expiresAt ?? "")) && Date.parse(lease.expiresAt!) > this.now()
        ? [lease.guardInstanceId] : [];
    }));
    const attempts = await this.persistence.getWorkItemsByKind("personal_account_attempt");
    for (const item of attempts) {
      const outer = item as unknown as { attempt?: StoredAttempt };
      const attempt = outer.attempt;
      if (!attempt || attempt.ownerUserId !== ownerUserId || (attempt.status !== "RESERVED" && attempt.status !== "DISPATCHED") || liveInstances.has(attempt.guardInstanceId)) continue;
      const uncertainDispatch = attempt.status === "DISPATCHED";
      const charge = uncertainDispatch ? Math.max(attempt.estimatedMicros, attempt.actualMicros ?? 0, attempt.chargedMicros ?? 0) : 0;
      await this.persistence.withTransaction(async tx => {
        await tx.lockWorkItem(item.id);
        await tx.lockWorkItem(attempt.domainId);
        await tx.lockWorkItem(attempt.budgetId);
        if (attempt.guardInstanceId) await tx.lockWorkItem(`personal-account-guard-${sha(`${ownerUserId}\0${attempt.guardInstanceId}`)}`);
        const stored = await tx.getWorkItem(item.id) as unknown as { attempt?: StoredAttempt } | undefined;
        const current = stored?.attempt;
        if (!current || (current.status !== "RESERVED" && current.status !== "DISPATCHED") || liveInstances.has(current.guardInstanceId)) return;
        const instanceLease = current.guardInstanceId
          ? await tx.getWorkItem(`personal-account-guard-${sha(`${ownerUserId}\0${current.guardInstanceId}`)}`) as unknown as { expiresAt?: string } | undefined
          : undefined;
        if (instanceLease && Number.isFinite(Date.parse(instanceLease.expiresAt ?? "")) && Date.parse(instanceLease.expiresAt!) > this.now()) return;
        const domain = (await tx.getWorkItem(current.domainId) as unknown as { domain?: StoredDomain } | undefined)?.domain ?? {};
        const budgetWork = await tx.getWorkItem(current.budgetId) as unknown as { ownerUserId?: string; budget?: StoredBudget } | undefined;
        const budget = budgetWork?.budget ?? { consumedMicros: 0, reservedMicros: 0 };
        if (domain.inFlight === item.id) {
          const { inFlight: _inFlight, ...rest } = domain;
          await tx.upsertWorkItem({ id: current.domainId, kind: "personal_account_domain", domain: { ...rest, ...(uncertainDispatch ? { accountingUncertain: true } : {}) } } as unknown as WorkItem);
        }
        const nextBudget = { ...budget, reservedMicros: Math.max(0, budget.reservedMicros - current.estimatedMicros),
          ...(uncertainDispatch ? { consumedMicros: Math.min(Number.MAX_SAFE_INTEGER, budget.consumedMicros + charge), unexpectedCharge: true } : {}) };
        await tx.upsertWorkItem({ id: current.budgetId, kind: "personal_account_budget", ownerUserId, connectionId: current.connectionId, budget: nextBudget } as unknown as WorkItem);
        await tx.upsertWorkItem({ id: item.id, kind: "personal_account_attempt", attempt: { ...current,
          status: uncertainDispatch ? "RECONCILED_UNCERTAIN" : "RELEASED", chargedMicros: uncertainDispatch ? charge : 0,
          ...(uncertainDispatch ? { accountingUncertain: true } : {}), orphanedAt: new Date(this.now()).toISOString() } } as unknown as WorkItem);
      });
      const persistedBudget = await this.persistence.getWorkItem(attempt.budgetId) as unknown as { budget?: StoredBudget } | undefined;
      const persistedDomain = await this.persistence.getWorkItem(attempt.domainId) as unknown as { domain?: StoredDomain } | undefined;
      if (persistedBudget?.budget) this.budgets.set(attempt.budgetId, { ...persistedBudget.budget });
      if (persistedDomain?.domain) this.domains.set(attempt.domainId, { ...persistedDomain.domain });
    }
  }

  private budgetId(binding: PersonalAccountBinding): string {
    const date = new Date(this.now());
    const month = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
    return `personal-account-budget-${sha(`${binding.ownerUserId}\0${binding.connectionId}\0${month}`)}`;
  }

  private admission(binding: PersonalAccountBinding, request?: ChatRequest, credential?: string): Admission {
    const now = this.now();
    const authority = this.authority(binding);
    if (!authority || authority.ownerUserId !== binding.ownerUserId || authority.connectionId !== binding.connectionId || authority.providerId !== binding.canonicalProviderId || authority.credentialRef !== binding.credentialRef) fail("PERSONAL_ACCOUNT_AUTHORITY_MISSING");
    if (!authority.enabled || authority.authState !== "ok" || authority.accountClass === "REVOKED" || !current(authority.verifiedAt, authority.recheckAt, now)
      || (authority.expiresAt !== undefined && (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= now))) fail("PERSONAL_ACCOUNT_AUTHORITY_STALE");
    if (credential !== undefined && authority.credentialFingerprint !== undefined && sha(credential) !== authority.credentialFingerprint) fail("PERSONAL_ACCOUNT_CREDENTIAL_CHANGED");
    if (request && authority.authorizedWorkspacePath !== undefined) {
      const actual = request.metadata?.personalAccountWorkspacePath;
      const normalize = (workspace: string): string => process.platform === "win32" ? path.resolve(workspace).toLowerCase() : path.resolve(workspace);
      if (typeof actual !== "string" || normalize(actual) !== normalize(authority.authorizedWorkspacePath)) fail("PERSONAL_ACCOUNT_WORKSPACE_MISMATCH");
    }
    const policy = this.options.personalRoutingPolicy?.(binding.ownerUserId);
    if (policy && !modes.has(policy.mode)) fail("PERSONAL_ACCOUNT_POLICY_INVALID");
    if (policy?.mode === "SPECIFIC_ACCOUNT" && policy.specificConnectionId !== binding.connectionId) fail("PERSONAL_ACCOUNT_NOT_SELECTED");
    if (authority.preference === "MANUAL" && (policy?.mode !== "SPECIFIC_ACCOUNT" || policy.specificConnectionId !== binding.connectionId)) fail("PERSONAL_ACCOUNT_MANUAL_SELECTION_REQUIRED");
    const price = authority.modelPricing?.find(candidate => candidate.modelId === binding.modelId);
    if (!price || price.confidence !== "AUTHORITATIVE" || price.currency !== "USD" || !price.tokenOnly || !bounded(price.source)
      || !current(price.verifiedAt, price.recheckAt, now) || ![price.inputCostPerMillion, price.outputCostPerMillion].every(rate => Number.isFinite(rate) && rate >= 0)
      || binding.pricing.confidence !== "AUTHORITATIVE" || binding.pricing.currency !== "USD" || binding.pricing.source !== price.source
      || binding.pricing.inputCostPerMillion !== price.inputCostPerMillion || binding.pricing.outputCostPerMillion !== price.outputCostPerMillion) fail("PERSONAL_ACCOUNT_PRICE_UNVERIFIED");
    const evidence = authority.admissionEvidence;
    const free = authority.accountClass === "FREE_VERIFIED" && authority.freeAdmissionVerified === true && authority.quotaScopeVerified === true && price.inputCostPerMillion === 0 && price.outputCostPerMillion === 0
      && !!evidence?.sourceDocumentation && !!evidence.termsEvidence && !!evidence.privacyEvidence && !!evidence.priceEvidence && current(evidence.verifiedAt, evidence.recheckAt, now)
      && [evidence.termsExpiresAt, evidence.privacyExpiresAt, evidence.priceExpiresAt].every(expiry => expiry === undefined || (Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > now));
    if (!free && (!policy || policy.mode === "FREE_ONLY" || policy.paidEnabled !== true || policy.explicitConsent !== true || policy.limitationsAcknowledged !== true || authority.paidSpendingEnabled !== true)) fail("PERSONAL_ACCOUNT_PAID_DISABLED");
    const budgetCents = authority.monthlyBudgetCents;
    if (!free && (!Number.isSafeInteger(budgetCents) || budgetCents === undefined || budgetCents <= 0 || !Number.isSafeInteger(budgetCents * 10_000))) fail("PERSONAL_ACCOUNT_BUDGET_UNKNOWN");
    let estimatedMicros = 0;
    if (request) {
      if (request.model !== binding.modelId) fail("PERSONAL_ACCOUNT_MODEL_IDENTITY_MISMATCH");
      if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens === undefined || request.maxTokens <= 0) fail("PERSONAL_ACCOUNT_OUTPUT_BOUND_REQUIRED");
      if (request.fallbackModels?.some(model => model !== binding.modelId)) fail("PERSONAL_ACCOUNT_FALLBACK_DENIED");
      const promptBytes = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }), "utf8") + request.messages.length * 32 + 256;
      estimatedMicros = Math.ceil(promptBytes * price.inputCostPerMillion + request.maxTokens * price.outputCostPerMillion);
      if (!Number.isSafeInteger(estimatedMicros) || estimatedMicros < 0) fail("PERSONAL_ACCOUNT_PRICE_UNVERIFIED");
    }
    return { authority, price, free, estimatedMicros, budgetMicros: free ? 0 : budgetCents! * 10_000 };
  }

  async reserve(binding: PersonalAccountBinding, request: ChatRequest, credential: string): Promise<PersonalAccountReservation> {
    await this.touchGuardLease(binding.ownerUserId);
    await this.reconcileOrphanedAttempts(binding.ownerUserId);
    if (request.metadata?.personalAccountOwnerUserId !== binding.ownerUserId || (request.metadata.personalAccountConnectionId !== undefined && request.metadata.personalAccountConnectionId !== binding.connectionId)) fail("PERSONAL_ACCOUNT_REQUEST_OWNER_MISMATCH");
    const requestId = request.metadata.personalAccountRequestId;
    if (!bounded(requestId)) fail("PERSONAL_ACCOUNT_REQUEST_ID_REQUIRED");
    const admission = this.admission(binding, request, credential);
    const budgetId = this.budgetId(binding);
    const domainId = `personal-account-domain-${sha(personalAccountDomain(admission.authority))}`;
    const attemptId = `personal-account-attempt-${sha(`${binding.ownerUserId}\0${binding.connectionId}\0${requestId}`)}`;
    const requestDigest = sha(JSON.stringify({ model: request.model, system: request.system, messages: request.messages, tools: request.tools, maxTokens: request.maxTokens }));
    const record: StoredAttempt = { ownerUserId: binding.ownerUserId, guardInstanceId: this.guardInstanceId, connectionId: binding.connectionId, requestId, requestDigest, domainId, budgetId, estimatedMicros: admission.estimatedMicros, status: "RESERVED", price: admission.price };
    await this.persistence.withTransaction(async tx => {
      await tx.insertIfAbsent({ id: domainId, kind: "personal_account_domain", domain: {} } as unknown as WorkItem);
      await tx.lockWorkItem(domainId);
      await tx.insertIfAbsent({ id: budgetId, kind: "personal_account_budget", budget: { consumedMicros: 0, reservedMicros: 0 } } as unknown as WorkItem);
      await tx.lockWorkItem(budgetId);
      if (await tx.getWorkItem(attemptId)) fail("PERSONAL_ACCOUNT_REQUEST_ALREADY_RESERVED");
      const domain = (await tx.getWorkItem(domainId) as unknown as { domain: StoredDomain }).domain;
      if (domain.inFlight) fail("PERSONAL_ACCOUNT_DOMAIN_BUSY");
      if (domain.accountingUncertain) fail("PERSONAL_ACCOUNT_DOMAIN_ACCOUNTING_UNCERTAIN");
      if ((domain.cooldownUntil ?? 0) > this.now()) fail("PERSONAL_ACCOUNT_DOMAIN_COOLDOWN");
      const budget = (await tx.getWorkItem(budgetId) as unknown as { budget: StoredBudget }).budget;
      if (budget.unexpectedCharge) fail("PERSONAL_ACCOUNT_UNEXPECTED_CHARGE_BLOCKED");
      if (!admission.free && budget.consumedMicros + budget.reservedMicros + admission.estimatedMicros > admission.budgetMicros) fail("PERSONAL_ACCOUNT_BUDGET_EXHAUSTED");
      await tx.insertIfAbsent({ id: attemptId, kind: "personal_account_attempt", attempt: record } as unknown as WorkItem);
      const reservedBudget = { ...budget, reservedMicros: budget.reservedMicros + admission.estimatedMicros };
      await tx.upsertWorkItem({ id: budgetId, kind: "personal_account_budget", ownerUserId: binding.ownerUserId, connectionId: binding.connectionId, budget: reservedBudget } as unknown as WorkItem);
      await tx.upsertWorkItem({ id: domainId, kind: "personal_account_domain", domain: { ...domain, inFlight: attemptId } } as unknown as WorkItem);
    });
    const persistedBudget = await this.persistence.getWorkItem(budgetId) as unknown as { budget: StoredBudget };
    this.budgets.set(budgetId, { ...persistedBudget.budget });
    this.domains.set(domainId, { ...(await this.persistence.getWorkItem(domainId) as unknown as { domain: StoredDomain }).domain });
    let dispatched = false;
    let dispatchStarted = false;
    let settled = false;
    const finish = async (usage?: Usage, error?: unknown, uncertain = false): Promise<void> => {
      if (settled) return;
      let actualMicros: number | undefined;
      const reportedCostUsd = dispatched ? usage?.costUsd : undefined;
      const reportedMicros = reportedCostUsd === undefined ? undefined : Math.ceil(reportedCostUsd * 1_000_000);
      let accountingUncertain = dispatched && (error as { code?: unknown } | undefined)?.code === "MALFORMED_USAGE_COST"
        || reportedMicros !== undefined && (!Number.isSafeInteger(reportedMicros) || reportedMicros < 0);
      if (!accountingUncertain) actualMicros = reportedMicros;
      const measuredTokens = usage !== undefined && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0;
      if (dispatched && measuredTokens) {
        const pricedTokens = Math.ceil(usage.inputTokens * record.price.inputCostPerMillion + usage.outputTokens * record.price.outputCostPerMillion);
        if (!Number.isSafeInteger(pricedTokens) || pricedTokens < 0) accountingUncertain = true;
        else if (!accountingUncertain) actualMicros = Math.max(actualMicros ?? 0, pricedTokens);
      }
      // An unrepresentable amount blocks the budget; its reported USD value remains separate.
      const chargedMicros = accountingUncertain ? Number.MAX_SAFE_INTEGER : dispatched ? measuredTokens && !uncertain ? (actualMicros ?? record.estimatedMicros) : Math.max(actualMicros ?? 0, record.estimatedMicros) : 0;
      await this.persistence.withTransaction(async tx => {
        await tx.lockWorkItem(domainId);
        await tx.lockWorkItem(budgetId);
        const budget = (await tx.getWorkItem(budgetId) as unknown as { budget: StoredBudget }).budget;
        const domain = (await tx.getWorkItem(domainId) as unknown as { domain: StoredDomain }).domain;
        if (domain.inFlight !== attemptId || budget.reservedMicros < record.estimatedMicros) fail("PERSONAL_ACCOUNT_ACCOUNTING_STATE_INVALID");
        const structured = error as { code?: unknown; status?: unknown; retryAfterMs?: unknown; retryAfter?: unknown } | undefined;
        const rateLimited = structured?.status === 429 || structured?.code === "RATE_LIMITED";
        const retryDelay = typeof structured?.retryAfter === "number" ? structured.retryAfter - this.now() : structured?.retryAfterMs;
        const delay = typeof retryDelay === "number" && Number.isFinite(retryDelay) ? Math.max(1_000, Math.min(3_600_000, retryDelay)) : 60_000;
        const { inFlight: _inFlight, ...remainingDomain } = domain;
        const consumedMicros = budget.consumedMicros + chargedMicros;
        if (!Number.isSafeInteger(consumedMicros)) accountingUncertain = true;
        await tx.upsertWorkItem({ id: domainId, kind: "personal_account_domain", domain: { ...remainingDomain, ...(rateLimited ? { cooldownUntil: this.now() + delay } : {}) } } as unknown as WorkItem);
        await tx.upsertWorkItem({ id: budgetId, kind: "personal_account_budget", ownerUserId: binding.ownerUserId, connectionId: binding.connectionId, budget: { ...budget, consumedMicros: Math.min(Number.MAX_SAFE_INTEGER, consumedMicros), reservedMicros: budget.reservedMicros - record.estimatedMicros, ...(accountingUncertain || actualMicros !== undefined && actualMicros > record.estimatedMicros ? { unexpectedCharge: true } : {}) } } as unknown as WorkItem);
        await tx.upsertWorkItem({ id: attemptId, kind: "personal_account_attempt", attempt: { ...record, status: dispatched ? "SETTLED" : "RELEASED", chargedMicros, ...(actualMicros === undefined ? {} : { actualMicros }), ...(typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0 ? { reportedCostUsd } : {}), ...(accountingUncertain ? { accountingUncertain: true } : {}) } } as unknown as WorkItem);
      });
      const persisted = await this.persistence.getWorkItem(budgetId) as unknown as { budget: StoredBudget };
      this.budgets.set(budgetId, { ...persisted.budget });
      this.domains.set(domainId, { ...(await this.persistence.getWorkItem(domainId) as unknown as { domain: StoredDomain }).domain });
      settled = true;
      if (accountingUncertain) fail("PERSONAL_ACCOUNT_ACCOUNTING_UNCERTAIN");
      if (actualMicros !== undefined && actualMicros > record.estimatedMicros) fail("PERSONAL_ACCOUNT_COST_EXCEEDED_RESERVATION");
    };
    return {
      dispatch: async () => {
        if (dispatchStarted || dispatched || settled) fail("PERSONAL_ACCOUNT_REQUEST_ALREADY_DISPATCHED");
        dispatchStarted = true;
        const refreshed = this.admission(binding, request, credential);
        if (personalAccountDomain(refreshed.authority) !== personalAccountDomain(admission.authority) || refreshed.estimatedMicros !== record.estimatedMicros) fail("PERSONAL_ACCOUNT_AUTHORITY_CHANGED");
        if (!refreshed.free && this.options.onEstimate) {
          const budget = (await this.persistence.getWorkItem(budgetId) as unknown as { budget: StoredBudget }).budget;
          const metadata = request.metadata;
          try {
            await this.options.onEstimate({ ownerUserId: binding.ownerUserId, connectionId: binding.connectionId,
              providerId: binding.canonicalProviderId, modelId: binding.modelId, requestId,
              estimatedCostUsd: record.estimatedMicros / 1_000_000,
              remainingBudgetUsd: Math.max(0, refreshed.budgetMicros - budget.consumedMicros - budget.reservedMicros) / 1_000_000,
              currency: "USD", pricingSource: refreshed.price.source,
              ...(bounded(metadata?.personalAccountSessionId) ? { sessionId: metadata.personalAccountSessionId } : {}),
              ...(bounded(metadata?.personalAccountRunId) ? { runId: metadata.personalAccountRunId } : {}),
              ...(typeof metadata?.personalAccountWorkspacePath === "string" ? { workspacePath: metadata.personalAccountWorkspacePath } : {}),
              purpose: metadata?.personalAccountPurpose === "QUALIFICATION" ? "QUALIFICATION" : "INFERENCE" });
          } catch (error) {
            if (error instanceof PersonalAccountPolicyError) throw error;
            fail("PERSONAL_ACCOUNT_ESTIMATE_UNAVAILABLE");
          }
          record.estimatePresentedAt = new Date(this.now()).toISOString();
          // Presentation can yield to account switching or a pricing refresh.
          const afterPresentation = this.admission(binding, request, credential);
          if (personalAccountDomain(afterPresentation.authority) !== personalAccountDomain(admission.authority)
            || afterPresentation.estimatedMicros !== record.estimatedMicros) fail("PERSONAL_ACCOUNT_AUTHORITY_CHANGED");
        }
        await this.persistence.withTransaction(async tx => {
          await tx.lockWorkItem(domainId);
          await tx.lockWorkItem(budgetId);
          const budget = (await tx.getWorkItem(budgetId) as unknown as { budget: StoredBudget }).budget;
          const domain = (await tx.getWorkItem(domainId) as unknown as { domain: StoredDomain }).domain;
          if (budget.unexpectedCharge) fail("PERSONAL_ACCOUNT_UNEXPECTED_CHARGE_BLOCKED");
          if (domain.inFlight !== attemptId || budget.reservedMicros < record.estimatedMicros) fail("PERSONAL_ACCOUNT_ACCOUNTING_STATE_INVALID");
          if (!refreshed.free && budget.consumedMicros + budget.reservedMicros > refreshed.budgetMicros) fail("PERSONAL_ACCOUNT_BUDGET_EXHAUSTED");
          await tx.upsertWorkItem({ id: attemptId, kind: "personal_account_attempt", attempt: { ...record, status: "DISPATCHED" } } as unknown as WorkItem);
        });
        dispatched = true;
      },
      settle: usage => finish(usage),
      fail: (error, usage) => finish(usage, error, true),
    };
  }
}
