import { createHash, createPublicKey, randomUUID } from "node:crypto";
import type { ISessionPersistence, SessionPersistenceTx } from "@codeforge/sessions";
import type { SecretEnvelopeService } from "@codeforge/crypto";
import { ChatRequestSchema, ChatResponseSchema, ToolCallSchema, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord, freeRouteExclusionReason, materializeSponsoredRoute, verifySponsorManifest, type CapacityRoute, type FreeModelRecord, type ProviderCapacityPool, type SignedSponsorManifest, type SponsoredRouteOffer, type SponsorTrustedKey } from "@codeforge/forge-zero";

export interface SponsorOfferScope { providerId: string; models: readonly string[]; maxConcurrency: number }
export interface SponsorOperatorPolicy {
  isTestProvider?: boolean;
  scopesForUser(userId: string): readonly SponsorOfferScope[];
  verify(manifest: SignedSponsorManifest, signal: AbortSignal): Promise<SponsorIndependentVerification>;
  execute(route: CapacityRoute, request: ChatRequest, userId: string, signal: AbortSignal): Promise<ChatResponse>;
}
export interface SponsorIndependentVerification {
  manifestSha256: string;
  offer: SponsoredRouteOffer;
  quotaOwnerId: string;
  independenceKey: string;
  billingReceiptId: string;
  capacityReceiptId: string;
  termsHash: string;
  privacyHash: string;
  verifiedAt: string;
  expiresAt: string;
  model: ProviderModel;
  providerUnitsPerRequestUpperBound?: number;
}
interface Operator {
  operatorId: string; ownerUserId: string; enrolledAt: string; state: "ACTIVE" | "REVOKED";
  scopes: SponsorOfferScope[]; keys: Array<SponsorTrustedKey & { fingerprint: string; revoked: boolean }>;
}
interface Offer {
  id: string; manifest: SignedSponsorManifest; digest: string; state: "INERT" | "ADMITTED" | "SUSPENDED" | "REVOKED";
  verification?: SponsorIndependentVerification; reason?: string;
}
interface PoolUsage { independenceKey: string; counters: Record<string, { resetAt: string; spent: number }>; lastUser?: string }
interface Job {
  id: string; userId: string; offerId: string; digest: string; payload: string; role: string;
  state: "QUEUED" | "DISPATCHED" | "FINISHED" | "BLOCKED"; createdAt: string; updatedAt: string;
  deadline: number; dispatchId?: string; result?: string; error?: string;
  usage?: { inputTokens?: number; outputTokens?: number; upstreamCostUsd?: number; costState: "REPORTED" | "UNKNOWN"; codeForgeMarginalCostUsd: 0 };
}
interface Registry { version: 1; operators: Operator[]; offers: Offer[]; pools: PoolUsage[]; jobs: Job[] }
const REGISTRY_ID = "sponsor-operator-registry:v1";
const SESSION_ID = "sponsor-operator-authority";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const sponsorManifestDigest = (manifest: SignedSponsorManifest): string => hash(JSON.stringify(manifest));
const iso = (now: number): string => new Date(now).toISOString();
const requiredId = (value: string): void => { if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error("SPONSOR_ID_INVALID"); };

/** Operators supply proposals; only the host's independent verifier can supply admission evidence. */
export class SponsorOperatorService {
  private snapshot: Registry = { version: 1, operators: [], offers: [], pools: [], jobs: [] };
  private readonly workers = new Set<Promise<void>>();
  private stopped = false;
  private serial: Promise<unknown> = Promise.resolve();
  private recoveryTimer?: NodeJS.Timeout;
  private readonly activeControllers = new Map<string, AbortController>();
  constructor(private readonly persistence: ISessionPersistence, private readonly envelopes: SecretEnvelopeService,
    private readonly policy: SponsorOperatorPolicy, private readonly now: () => number = Date.now) {
    if (policy.isTestProvider && process.env.NODE_ENV !== "test" && process.env.CODEFORGE_ALLOW_TEST_PROVIDERS !== "1") throw new Error("SPONSOR_TEST_OPERATOR_DENIED");
  }

  async init(): Promise<void> {
    await this.persistence.init();
    const now = iso(this.now());
    await this.persistence.upsertSession({ id: SESSION_ID, title: "Sponsor operator authority", createdAt: now, updatedAt: now, status: "idle" });
    await this.persistence.insertIfAbsent({ kind: "sponsor_operator_registry", id: REGISTRY_ID, sessionId: SESSION_ID, createdAt: now, updatedAt: now, stateJson: JSON.stringify(this.snapshot) });
    await this.mutate("RECOVERY", "system", (state) => {
      // A dispatched request may have reached the provider; never replay it after a crash.
      for (const job of state.jobs) if (job.state === "DISPATCHED" && job.deadline <= this.now()) { job.state = "BLOCKED"; job.error = "DISPATCH_OUTCOME_UNKNOWN"; job.payload = ""; }
    });
    this.recoveryTimer = setInterval(() => this.pump(), 1000);
    this.recoveryTimer.unref();
    this.pump();
  }

  private async mutate<T>(action: string, actor: string, operation: (state: Registry) => T): Promise<T> {
    let committedState: Registry | undefined;
    const pending = this.serial.then(() => this.persistence.withTransaction(async (tx: SessionPersistenceTx) => {
      await tx.lockWorkItem(REGISTRY_ID);
      const row = await tx.getWorkItem(REGISTRY_ID);
      if (row?.kind !== "sponsor_operator_registry") throw new Error("SPONSOR_STORAGE_UNINITIALIZED");
      const state = JSON.parse(row.stateJson) as Registry;
      if (state.version !== 1) throw new Error("SPONSOR_STORAGE_VERSION_INVALID");
      const result = operation(state);
      const at = iso(this.now());
      await tx.upsertWorkItem({ ...row, updatedAt: at, stateJson: JSON.stringify(state) });
      if (action) await tx.appendEvent({ type: "sponsor.operator.audit", sessionId: SESSION_ID, id: randomUUID(), action, actor, timestamp: at, details: result });
      committedState = state;
      return result;
    }));
    this.serial = pending.catch(() => undefined);
    const result = await pending;
    if (committedState) this.snapshot = committedState;
    return result;
  }

  async enroll(userId: string, operatorId: string): Promise<Operator> {
    requiredId(operatorId);
    const scopes = this.policy.scopesForUser(userId).map((scope) => ({ ...scope, models: [...scope.models] }));
    if (!userId || !scopes.length || scopes.some((scope) => !scope.models.length || !Number.isInteger(scope.maxConcurrency) || scope.maxConcurrency < 1)) throw new Error("SPONSOR_ENROLLMENT_NOT_AUTHORIZED");
    return this.mutate("ENROLLED", userId, (state) => {
      if (state.operators.length >= 100 || state.operators.some((operator) => operator.operatorId === operatorId)) throw new Error("SPONSOR_OPERATOR_EXISTS_OR_LIMIT");
      const operator: Operator = { operatorId, ownerUserId: userId, enrolledAt: iso(this.now()), state: "ACTIVE", scopes, keys: [] };
      state.operators.push(operator);
      return structuredClone(operator);
    });
  }

  private owner(state: Registry, userId: string, operatorId: string): Operator {
    const operator = state.operators.find((entry) => entry.operatorId === operatorId && entry.ownerUserId === userId && entry.state === "ACTIVE");
    if (!operator) throw new Error("SPONSOR_OPERATOR_NOT_AUTHORIZED");
    return operator;
  }

  async addKey(userId: string, operatorId: string, input: Omit<SponsorTrustedKey, "sponsorId">, rotateKeyId?: string): Promise<{ fingerprint: string }> {
    requiredId(input.keyId);
    if (input.publicKeyPem.length > 4096 || input.publicKeyPem.includes("PRIVATE KEY")) throw new Error("SPONSOR_PUBLIC_KEY_REQUIRED");
    const publicKey = createPublicKey(input.publicKeyPem);
    const now = this.now();
    if (publicKey.asymmetricKeyType !== "ed25519" || !Number.isFinite(Date.parse(input.validFrom)) || !Number.isFinite(Date.parse(input.validUntil))
      || Date.parse(input.validFrom) > now || Date.parse(input.validUntil) <= now || Date.parse(input.validUntil) - now > 366 * 86_400_000) throw new Error("SPONSOR_KEY_INVALID");
    const fingerprint = hash(publicKey.export({ format: "der", type: "spki" }).toString("base64"));
    return this.mutate(rotateKeyId ? "KEY_ROTATED" : "KEY_ADDED", userId, (state) => {
      const operator = this.owner(state, userId, operatorId);
      if (operator.keys.length >= 32 || operator.keys.some((key) => key.keyId === input.keyId || key.fingerprint === fingerprint)) throw new Error("SPONSOR_KEY_EXISTS_OR_LIMIT");
      if (rotateKeyId) {
        const previous = operator.keys.find((key) => key.keyId === rotateKeyId && !key.revoked);
        if (!previous) throw new Error("SPONSOR_KEY_NOT_FOUND");
        previous.revoked = true;
        this.invalidateKey(state, operatorId, rotateKeyId);
      }
      operator.keys.push({ ...input, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), sponsorId: operatorId, fingerprint, revoked: false });
      return { fingerprint, operatorId, keyId: input.keyId, rotateKeyId };
    });
  }

  private invalidateKey(state: Registry, operatorId: string, keyId?: string): void {
    for (const offer of state.offers) if (offer.manifest.sponsorId === operatorId && (!keyId || offer.manifest.keyId === keyId)) {
      offer.state = "SUSPENDED"; offer.reason = "SIGNER_REVOKED";
    }
  }
  async revoke(userId: string, operatorId: string, keyId?: string): Promise<void> {
    await this.mutate(keyId ? "KEY_REVOKED" : "OPERATOR_REVOKED", userId, (state) => {
      const operator = this.owner(state, userId, operatorId);
      if (keyId) { const key = operator.keys.find((entry) => entry.keyId === keyId); if (!key) throw new Error("SPONSOR_KEY_NOT_FOUND"); key.revoked = true; }
      else operator.state = "REVOKED";
      this.invalidateKey(state, operatorId, keyId);
      return { operatorId, keyId };
    });
  }

  async submitManifest(userId: string, input: unknown): Promise<{ offerId: string; state: string; manifest: SignedSponsorManifest; supersededSequence?: number }> {
    return this.mutate("MANIFEST_SUBMITTED", userId, (state) => {
      const verdict = verifySponsorManifest(input, state.operators.filter((operator) => operator.ownerUserId === userId && operator.state === "ACTIVE").flatMap((operator) => operator.keys.filter((key) => !key.revoked)), this.now());
      if (verdict.status !== "SIGNATURE_VALID") throw new Error(`SPONSOR_${verdict.reason}`);
      const manifest = verdict.manifest;
      const operator = this.owner(state, userId, manifest.sponsorId);
      const scope = operator.scopes.find((entry) => entry.providerId === manifest.providerId && entry.models.includes(manifest.physicalModel));
      if (!scope || manifest.concurrency > scope.maxConcurrency) throw new Error("SPONSOR_OFFER_SCOPE_DENIED");
      const id = `${manifest.sponsorId}:${manifest.offerId}`;
      const old = state.offers.find((entry) => entry.id === id);
      if (old && (old.manifest.sequence >= manifest.sequence || old.state === "REVOKED")) throw new Error("SPONSOR_MANIFEST_REPLAY_OR_REVOKED");
      if (!old && state.offers.length >= 1000) throw new Error("SPONSOR_OFFER_LIMIT");
      const next: Offer = { id, manifest, digest: sponsorManifestDigest(manifest), state: manifest.revoked ? "REVOKED" : "INERT" };
      if (old) state.offers[state.offers.indexOf(old)] = next; else state.offers.push(next);
      return { offerId: id, state: next.state, manifest, supersededSequence: old?.manifest.sequence };
    });
  }

  async verifyOffer(userId: string, offerId: string): Promise<{ state: string; routeId: string }> {
    const candidate = await this.mutate("VERIFICATION_STARTED", userId, (state) => {
      const offer = state.offers.find((entry) => entry.id === offerId);
      if (!offer || offer.state === "REVOKED") throw new Error("SPONSOR_OFFER_NOT_FOUND");
      this.owner(state, userId, offer.manifest.sponsorId);
      offer.state = "INERT";
      return structuredClone(offer);
    });
    const verification = await this.policy.verify(candidate.manifest, AbortSignal.timeout(120_000));
    return this.mutate("VERIFICATION_COMPLETED", userId, (state) => {
      const offer = state.offers.find((entry) => entry.id === offerId);
      if (!offer || offer.digest !== candidate.digest || offer.state === "REVOKED") throw new Error("SPONSOR_VERIFICATION_SUPERSEDED");
      const operator = this.owner(state, userId, offer.manifest.sponsorId);
      if (verifySponsorManifest(offer.manifest, operator.keys.filter((key) => !key.revoked), this.now()).status !== "SIGNATURE_VALID") throw new Error("SPONSOR_SIGNER_INVALID");
      this.checkVerification(offer, verification);
      for (const other of state.offers) if (other.id !== offer.id && other.state === "ADMITTED" && other.verification?.independenceKey === verification.independenceKey) {
        if (JSON.stringify(other.verification.offer.quota) !== JSON.stringify(verification.offer.quota)) throw new Error("SPONSOR_SHARED_WALLET_BOUNDS_CONFLICT");
      }
      offer.verification = verification; offer.state = "ADMITTED"; delete offer.reason;
      if (!state.pools.some((pool) => pool.independenceKey === verification.independenceKey)) state.pools.push({ independenceKey: verification.independenceKey, counters: {} });
      return { state: offer.state, routeId: this.route(offer, state)!.routeId };
    });
  }

  private checkVerification(candidate: Offer, verification: SponsorIndependentVerification): void {
    const { offer } = verification;
    const m = candidate.manifest;
    const now = this.now();
    if (verification.manifestSha256 !== candidate.digest || !verification.quotaOwnerId || !verification.independenceKey || !verification.billingReceiptId || !verification.capacityReceiptId
      || verification.termsHash !== m.termsHash || verification.privacyHash !== m.privacyHash
      || !Number.isFinite(Date.parse(verification.verifiedAt)) || Date.parse(verification.verifiedAt) > now || now - Date.parse(verification.verifiedAt) >= 6 * 60 * 60_000
      || !Number.isFinite(Date.parse(verification.expiresAt)) || Date.parse(verification.expiresAt) <= now || Date.parse(verification.expiresAt) > Date.parse(m.expiresAt)
      || offer.sponsorId !== m.sponsorId || offer.providerId !== m.providerId || offer.physicalModel !== m.physicalModel || offer.logicalModel !== m.logicalRouteId
      || offer.startAt !== m.startsAt || offer.expiresAt !== m.expiresAt || offer.maxConcurrency > m.concurrency
      || offer.privacyClass !== m.privacyClass || offer.trainingUse !== m.trainingUse || !offer.roles.length
      || verification.model.modelId !== m.physicalModel || verification.model.freeStatus !== "verified_free" || !verification.model.isFree
      || !verification.model.contextWindow || !Number.isFinite(verification.model.contextWindow) || verification.model.contextWindow < 1 || !verification.model.capabilities.text || !verification.model.capabilities.toolCalling
      || new Set(offer.quota.map((window) => `${window.unit}:${window.period}`)).size !== offer.quota.length
      || offer.quota.length !== m.quota.length || offer.quota.some((window, index) => {
        const bound = m.quota[index]!;
        return window.unit !== bound.unit || window.period !== bound.period || !window.authoritative || !Number.isFinite(window.limit) || window.limit <= 0 || window.limit > bound.limit || window.remaining > window.limit
          || !Number.isFinite(window.remaining) || window.remaining < 0 || !Number.isFinite(Date.parse(window.resetAt)) || Date.parse(window.resetAt) <= now;
      }) || (offer.quota.some((window) => window.unit === "provider_units") && (!verification.providerUnitsPerRequestUpperBound || !Number.isFinite(verification.providerUnitsPerRequestUpperBound)))
      || !materializeSponsoredRoute(offer, now)) throw new Error("SPONSOR_INDEPENDENT_EVIDENCE_INVALID");
  }

  private route(offer: Offer, state: Registry = this.snapshot): CapacityRoute | undefined {
    if (offer.state !== "ADMITTED" || !offer.verification) return undefined;
    const operator = state.operators.find((entry) => entry.operatorId === offer.manifest.sponsorId && entry.state === "ACTIVE");
    if (!operator || verifySponsorManifest(offer.manifest, operator.keys.filter((key) => !key.revoked), this.now()).status !== "SIGNATURE_VALID") return undefined;
    try { this.checkVerification(offer, offer.verification); } catch { return undefined; }
    const route = materializeSponsoredRoute(offer.verification.offer, this.now());
    if (!route) return undefined;
    const poolId = `sponsor-pool:${hash(offer.verification.independenceKey).slice(0, 32)}`;
    const pool = state.pools.find((entry) => entry.independenceKey === offer.verification!.independenceKey);
    const windows = route.windows.map((window) => {
      const spent = pool?.counters[`${window.unit}:${window.period}`]?.spent ?? 0;
      return { ...window, remaining: Math.max(0, window.remaining - spent) };
    });
    const identityHash = hash(offer.verification.independenceKey);
    const productRoles: Record<string, string> = { CODER: "PRIMARY_CODING_AGENT", EXPLORER: "SUBAGENT", PLANNER: "PLANNER", REVIEWER: "REVIEWER", TESTER: "SUBAGENT", LEAD: "FAST_REASONER" };
    return { ...route, providerId: poolId, upstreamProvider: offer.manifest.providerId, routeId: `${poolId}:${offer.manifest.offerId}`, quotaDomainId: poolId, capacityPoolId: poolId, capacityIdentity: poolId,
      independenceKey: `${poolId}:SPONSORED:${identityHash}`, quotaScopeEvidence: { scope: "SPONSORED", identityHash, source: offer.verification.capacityReceiptId, verifiedAt: offer.verification.verifiedAt, recheckAt: offer.verification.expiresAt },
      roles: [...new Set([...route.roles, ...route.roles.flatMap((role) => productRoles[role] ? [productRoles[role]!] : [])])], contextWindow: offer.verification.model.contextWindow, windows };
  }
  capacityRoutes(): CapacityRoute[] { return this.snapshot.offers.flatMap((offer) => { const route = this.route(offer); return route ? [route] : []; }); }
  capacityPools(): ProviderCapacityPool[] {
    return [...new Map(this.capacityRoutes().map((route) => [route.capacityPoolId, { poolId: route.capacityPoolId, providerId: route.providerId, scope: "SHARED_OWNER_POOL" as const, supplyClass: route.supplyClass, windows: route.windows, observedAt: iso(this.now()), authoritative: true, capacityIdentity: route.capacityIdentity }])).values()];
  }
  modelRecords(): FreeModelRecord[] {
    return this.capacityRoutes().map((route) => {
      const offer = this.snapshot.offers.find((entry) => entry.manifest.offerId === route.routeId.slice(route.capacityPoolId.length + 1) && this.route(entry)?.routeId === route.routeId)!;
      const model = offer.verification!.model;
      const record = createGenericFreeRecord({ providerId: route.providerId, modelId: route.modelId, displayName: model.displayName });
      return { ...record, contextWindow: model.contextWindow!, capabilities: model.capabilities, privacyClass: route.privacyClass,
        freeStatusVerifiedAt: offer.verification!.verifiedAt, costProfile: { ...record.costProfile, freeTierVerifiedAt: offer.verification!.verifiedAt, source: offer.verification!.billingReceiptId } };
    });
  }
  providerAdapters(): ProviderAdapter[] {
    const service = this;
    return [...new Set(this.capacityRoutes().map((route) => route.providerId))].map((providerId): ProviderAdapter => ({
      providerId,
      isTestProvider: service.policy.isTestProvider === true,
      listModels: async () => service.snapshot.offers.filter((offer) => service.route(offer)?.providerId === providerId).map((offer) => offer.verification!.model),
      canRoute: (modelId) => service.capacityRoutes().some((route) => route.providerId === providerId && route.modelId === modelId),
      healthCheck: async () => ({ status: service.capacityRoutes().some((route) => route.providerId === providerId) ? "available" : "offline" }),
      chat: async () => { throw new Error("SPONSOR_AUTHENTICATED_CONTEXT_REQUIRED"); },
      async *streamChat(): AsyncIterable<StreamEvent> { throw new Error("SPONSOR_AUTHENTICATED_CONTEXT_REQUIRED"); },
      async *streamChatWithContext(request, context, signal): AsyncIterable<StreamEvent> {
        if (!context.userId || !context.userId.trim() || context.userId === "anonymous") throw new Error("SPONSOR_AUTHENTICATED_CONTEXT_REQUIRED");
        const role = typeof context.metadata?.role === "string" ? context.metadata.role : "CODER";
        const offer = service.snapshot.offers.find((entry) => { const route = service.route(entry); return route?.providerId === providerId && route.modelId === request.model && route.roles.includes(role); });
        if (!offer) throw new Error("SPONSOR_ROUTE_NOT_ADMITTED");
        const requestId = request.dispatchId ?? randomUUID();
        const { metadata: _metadata, dispatchId: _dispatchId, fallbackModels: _fallbackModels, ...boundedRequest } = request;
        if (request.fallbackModels?.some((model) => model !== request.model)) throw new Error("SPONSOR_PAID_FALLBACK_DENIED");
        await service.enqueue(context.userId, offer.id, requestId, role, boundedRequest);
        for (;;) {
          if (signal?.aborted) { await service.cancelJob(context.userId, requestId); throw new Error("SPONSOR_CANCELLED"); }
          const status = await service.jobStatus(context.userId, requestId) as { state: string; error?: string; result?: ChatResponse };
          if (status.state === "BLOCKED") {
            if (status.error === "SPONSOR_RATE_LIMITED_429" || status.error === "SPONSOR_ALLOWANCE_EXHAUSTED") throw new Error("[PROVIDER_RATE_LIMITED] Sponsor quota capacity exhausted (429)");
            if (status.error === "SPONSOR_AUTH_REVOKED") throw new Error("[PROVIDER_AUTH_FAILED] Sponsor grant credential revoked (401)");
            throw new Error(status.error ?? "SPONSOR_DISPATCH_BLOCKED");
          }
          if (status.state === "FINISHED" && status.result) {
            const choice = status.result.choices[0];
            if (choice?.message.content) yield { type: "text_delta", delta: choice.message.content };
            for (const raw of choice?.message.toolCalls ?? []) {
              const call = ToolCallSchema.parse(raw);
              yield { type: "tool_call_completed", toolCallId: call.id, toolName: call.function.name, arguments: call.function.arguments };
            }
            if (status.result.usage) yield { type: "usage", usage: status.result.usage };
            yield { type: "finish", finishReason: choice?.finishReason ?? "stop", model: status.result.model };
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      },
    }));
  }
  private async cancelJob(userId: string, requestId: string): Promise<void> {
    await this.mutate("USAGE_CANCELLED", userId, (state) => { const job = state.jobs.find((entry) => entry.id === hash(`${userId}\0${requestId}`)); if (job && (job.state === "QUEUED" || job.state === "DISPATCHED")) { job.state = "BLOCKED"; job.error = "CANCELLED"; job.payload = ""; } });
    this.activeControllers.get(hash(`${userId}\0${requestId}`))?.abort();
  }
  async status(userId: string): Promise<unknown> {
    return this.mutate("", userId, (state) => ({
      operators: state.operators.filter((operator) => operator.ownerUserId === userId).map((operator) => ({ ...operator, keys: operator.keys.map(({ publicKeyPem: _publicKeyPem, ...key }) => key) })),
      offers: state.offers.filter((offer) => state.operators.some((operator) => operator.operatorId === offer.manifest.sponsorId && operator.ownerUserId === userId)).map((offer) => ({ offerId: offer.id, sequence: offer.manifest.sequence, state: this.route(offer, state) ? "ADMITTED" : offer.state === "ADMITTED" ? "SUSPENDED" : offer.state, reason: offer.reason, expiresAt: offer.manifest.expiresAt })),
    }));
  }
  async revokeOffer(userId: string, offerId: string): Promise<void> {
    await this.mutate("OFFER_REVOKED", userId, (state) => { const offer = state.offers.find((entry) => entry.id === offerId); if (!offer) throw new Error("SPONSOR_OFFER_NOT_FOUND"); this.owner(state, userId, offer.manifest.sponsorId); offer.state = "REVOKED"; return { offerId }; });
  }

  async enqueue(userId: string, offerId: string, requestId: string, role: string, input: unknown): Promise<unknown> {
    requiredId(requestId);
    const request = ChatRequestSchema.parse(input);
    if (!userId || !request.maxTokens || request.fallbackModels?.length || request.dispatchId || request.metadata) throw new Error("SPONSOR_REQUEST_BOUNDS_REQUIRED");
    const id = hash(`${userId}\0${requestId}`);
    const serialized = JSON.stringify(request);
    const digest = hash(`${offerId}\0${role}\0${serialized}`);
    await this.mutate("USAGE_QUEUED", userId, (state) => {
      const prior = state.jobs.find((job) => job.id === id);
      if (prior) { if (prior.digest !== digest) throw new Error("SPONSOR_REQUEST_REPLAY_MISMATCH"); return; }
      const offer = state.offers.find((entry) => entry.id === offerId);
      const route = offer && this.route(offer, state);
      if (!route || request.model !== route.modelId || !route.roles.includes(role) || route.dataPolicyProfile !== "PRIVATE_CODE_ALLOWED"
        || freeRouteExclusionReason(route, { paidInferenceAllowed: false, allowUserConnectedFree: false, allowDistributedUserFree: false, allowDepositUnlockedFree: false, allowSponsoredFree: true })) throw new Error("SPONSOR_ROUTE_NOT_ADMITTED");
      state.jobs = state.jobs.filter((job) => job.state === "QUEUED" || job.state === "DISPATCHED" || Date.parse(job.updatedAt) > this.now() - 86_400_000);
      if (state.jobs.length >= 1000 || state.jobs.filter((job) => job.userId === userId && job.state === "QUEUED").length >= 16) throw new Error("SPONSOR_QUEUE_LIMIT");
      const at = iso(this.now());
      state.jobs.push({ id, userId, offerId, digest, role, state: "QUEUED", createdAt: at, updatedAt: at, deadline: this.now() + 300_000,
        payload: this.envelopes.encrypt(serialized, { purpose: "sponsor_request", tenantId: userId, recordId: id }) });
    });
    this.pump();
    return this.jobStatus(userId, requestId);
  }
  async jobStatus(userId: string, requestId: string): Promise<unknown> {
    return this.mutate("", userId, (state) => {
      const job = state.jobs.find((entry) => entry.id === hash(`${userId}\0${requestId}`));
      if (!job) throw new Error("SPONSOR_JOB_NOT_FOUND");
      return { requestId, state: job.state, error: job.error, usage: job.usage,
        ...(job.result ? { result: JSON.parse(this.envelopes.decryptString(job.result, { purpose: "sponsor_result", tenantId: userId, recordId: job.id })) as unknown } : {}) };
    });
  }
  private pump(): void {
    if (this.stopped || !this.snapshot.jobs.some((job) => job.state === "QUEUED" || job.state === "DISPATCHED" && job.deadline <= this.now())) return;
    while (this.workers.size < 8) {
      const worker = this.drain().catch(() => undefined).finally(() => this.workers.delete(worker));
      this.workers.add(worker);
    }
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const claimed = await this.mutate("", "runtime", (state) => {
        for (const offer of state.offers) if (offer.state === "ADMITTED" && !this.route(offer, state)) { offer.state = "SUSPENDED"; offer.reason = "ADMISSION_EXPIRED_OR_DRIFTED"; }
        for (const job of state.jobs) if (job.state === "DISPATCHED" && job.deadline <= this.now()) { job.state = "BLOCKED"; job.error = "DISPATCH_OUTCOME_UNKNOWN"; job.payload = ""; }
        const queued = state.jobs.filter((job) => job.state === "QUEUED");
        for (const job of queued) if (job.deadline <= this.now()) { job.state = "BLOCKED"; job.error = "QUEUE_EXPIRED"; job.payload = ""; }
        const pending = queued.filter((job) => job.state === "QUEUED");
        const admitted = pending.filter((job) => { const offer = state.offers.find((entry) => entry.id === job.offerId); return offer && this.route(offer, state); });
        for (const job of pending) if (!admitted.includes(job)) { job.state = "BLOCKED"; job.error = "ADMISSION_EXPIRED_OR_REVOKED"; job.payload = ""; }
        const eligible = admitted.filter((job) => {
          const offer = state.offers.find((entry) => entry.id === job.offerId)!;
          const key = offer.verification!.independenceKey;
          const active = state.jobs.filter((entry) => entry.state === "DISPATCHED" && state.offers.find((candidate) => candidate.id === entry.offerId)?.verification?.independenceKey === key);
          return active.length < Math.min(...state.offers.filter((entry) => entry.state === "ADMITTED" && entry.verification?.independenceKey === key).map((entry) => entry.verification!.offer.maxConcurrency)) && !active.some((entry) => entry.userId === job.userId);
        });
        const first = eligible[0];
        const firstOffer = first && state.offers.find((entry) => entry.id === first.offerId);
        const walletJobs = firstOffer ? eligible.filter((job) => state.offers.find((entry) => entry.id === job.offerId)?.verification?.independenceKey === firstOffer.verification!.independenceKey) : [];
        const lastUser = firstOffer && state.pools.find((pool) => pool.independenceKey === firstOffer.verification!.independenceKey)?.lastUser;
        const users = [...new Set(walletJobs.map((job) => job.userId))].sort();
        const nextUser = users.find((user) => !lastUser || user > lastUser) ?? users[0];
        const next = walletJobs.find((job) => job.userId === nextUser);
        if (!next) return undefined;
        const offer = state.offers.find((entry) => entry.id === next.offerId)!;
        const route = this.route(offer, state)!;
        const pool = state.pools.find((entry) => entry.independenceKey === offer.verification!.independenceKey)!;
        const request = ChatRequestSchema.parse(JSON.parse(this.envelopes.decryptString(next.payload, { purpose: "sponsor_request", tenantId: next.userId, recordId: next.id })));
        // UTF-8 bytes safely upper-bound input tokens for the supported text/tool protocol.
        const inputBound = Buffer.byteLength(JSON.stringify(request.messages)) + Buffer.byteLength(JSON.stringify(request.tools ?? [])) + Buffer.byteLength(request.system ?? "") + 4096;
        const amounts: Record<string, number> = { requests: 1, input_tokens: inputBound, output_tokens: request.maxTokens!, provider_units: offer.verification!.providerUnitsPerRequestUpperBound ?? 0 };
        for (const window of offer.verification!.offer.quota) {
          const key = `${window.unit}:${window.period}`;
          let counter = pool.counters[key];
          if (!counter || Date.parse(counter.resetAt) <= this.now()) counter = pool.counters[key] = { resetAt: window.resetAt, spent: 0 };
          if (counter.spent + amounts[window.unit]! > window.remaining) { next.state = "BLOCKED"; next.error = "SPONSOR_ALLOWANCE_EXHAUSTED"; next.payload = ""; return { blocked: true as const }; }
        }
        for (const window of offer.verification!.offer.quota) pool.counters[`${window.unit}:${window.period}`]!.spent += amounts[window.unit]!;
        pool.lastUser = next.userId;
        next.state = "DISPATCHED"; next.dispatchId = randomUUID(); next.updatedAt = iso(this.now()); next.deadline = this.now() + 90_000;
        return { blocked: false as const, job: structuredClone(next), route, request };
      });
      if (!claimed) return;
      if (claimed.blocked) continue;
      const controller = new AbortController();
      this.activeControllers.set(claimed.job.id, controller);
      const timeout = setTimeout(() => controller.abort(), 60_000);
      let response: ChatResponse | undefined;
      let error: string | undefined;
      try {
        response = ChatResponseSchema.parse(await Promise.race([
          this.policy.execute(claimed.route, { ...claimed.request, dispatchId: claimed.job.dispatchId }, claimed.job.userId, controller.signal),
          new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("SPONSOR_DISPATCH_TIMEOUT")), { once: true })),
        ]));
        for (const choice of response.choices) for (const call of choice.message.toolCalls ?? []) ToolCallSchema.parse(call);
      } catch (failure) {
        const status = typeof (failure as { status?: unknown })?.status === "number" ? (failure as { status: number }).status : undefined;
        const message = failure instanceof Error ? failure.message : "";
        error = status === 429 || /\b429\b|rate.?limit/i.test(message) ? "SPONSOR_RATE_LIMITED_429"
          : status === 401 || status === 403 || /unauthor|invalid api key/i.test(message) ? "SPONSOR_AUTH_REVOKED" : "SPONSOR_PROVIDER_FAILURE";
      }
      finally { clearTimeout(timeout); this.activeControllers.delete(claimed.job.id); }
      await this.mutate("USAGE_SETTLED", claimed.job.userId, (state) => {
        const job = state.jobs.find((entry) => entry.id === claimed.job.id)!;
        const offer = state.offers.find((entry) => entry.id === job.offerId);
        if (job.state !== "DISPATCHED" || job.dispatchId !== claimed.job.dispatchId) return { jobId: job.id, state: job.state, reason: "DISPATCH_FENCE_DENIED" };
        job.payload = ""; job.updatedAt = iso(this.now());
        if (!response || !offer || !this.route(offer, state)) {
          job.state = "BLOCKED"; job.error = error ?? "ADMISSION_CHANGED_DURING_DISPATCH";
          if (offer && error) for (const sibling of state.offers) if (sibling.verification?.independenceKey === offer.verification?.independenceKey) { sibling.state = "SUSPENDED"; sibling.reason = error; }
          return { jobId: job.id, state: job.state, reason: job.error, quotaDomainId: claimed.route.quotaDomainId };
        }
        if (response.usage && response.usage.outputTokens > claimed.request.maxTokens!) { job.state = "BLOCKED"; job.error = "SPONSOR_USAGE_BOUND_EXCEEDED"; offer.state = "SUSPENDED"; return { jobId: job.id, state: job.state, reason: job.error }; }
        job.state = "FINISHED";
        job.result = this.envelopes.encrypt(JSON.stringify(response), { purpose: "sponsor_result", tenantId: job.userId, recordId: job.id });
        job.usage = { inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens, upstreamCostUsd: response.usage?.costUsd, costState: response.usage?.costUsd === undefined ? "UNKNOWN" : "REPORTED", codeForgeMarginalCostUsd: 0 };
        return { jobId: job.id, state: job.state, quotaDomainId: claimed.route.quotaDomainId, usage: job.usage };
      });
    }
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.recoveryTimer); for (const controller of this.activeControllers.values()) controller.abort(); await Promise.allSettled(this.workers); await this.serial; }
}
