import { randomUUID } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { FREE_PER_TASK_CREDIT_LIMIT, UsageEngine } from "@codeforge/cloud-usage";
import { REGION_UNKNOWN, type RegionResolution } from "@codeforge/legal-policy";
import { CloudFirewallManager } from "./cloud-firewall.js";
import type { HostedFinishReason, HostedInferenceRequest, HostedStreamEvent } from "./types.js";

export interface GatewayServiceConfig {
  firewallManager: CloudFirewallManager;
  entitlementService: EntitlementService;
  usageEngine: UsageEngine;
  db?: ICloudDatabase;
  inferenceTimeoutMs?: number;
}

export interface HostedRouteResolution {
  providerId: string;
  modelId: string;
  planId: string;
  maxConcurrent: number;
  estimatedCredits: number;
  accessClass?: string;
}

export interface HostedInferenceOutcome {
  messageId: string;
  fullText: string;
  finishReason: HostedFinishReason;
  usage: { inputTokens: number; outputTokens: number };
  creditsConsumed: number;
  balanceAfter: number;
}

const MAX_HOSTED_OUTPUT_TOKENS = 8000;

export class GatewayService {
  private readonly firewallManager: CloudFirewallManager;
  private readonly entitlementService: EntitlementService;
  private readonly usageEngine: UsageEngine;
  private readonly db?: ICloudDatabase;
  private readonly inferenceTimeoutMs: number;
  private readonly activeUserLeases = new Map<string, Set<string>>();

  constructor(config: GatewayServiceConfig) {
    this.firewallManager = config.firewallManager;
    this.entitlementService = config.entitlementService;
    this.usageEngine = config.usageEngine;
    this.db = config.db;
    this.inferenceTimeoutMs = config.inferenceTimeoutMs ?? 60000;
  }

  private acquireLease(userId: string, requestId: string, maxConcurrent: number): void {
    let leases = this.activeUserLeases.get(userId);
    if (!leases) {
      leases = new Set<string>();
      this.activeUserLeases.set(userId, leases);
    }
    if (leases.size >= maxConcurrent) {
      throw new Error(`Concurrent task limit reached (${leases.size}/${maxConcurrent})`);
    }
    leases.add(requestId);
  }

  private releaseLease(userId: string, requestId: string): void {
    const leases = this.activeUserLeases.get(userId);
    if (leases) {
      leases.delete(requestId);
      if (leases.size === 0) {
        this.activeUserLeases.delete(userId);
      }
    }
  }

  /**
   * Provider ids with a live adapter in this process — the capability scope a queue worker uses
   * so it only claims executions it can actually dispatch.
   */
  claimableProviderIds(): string[] {
    return this.firewallManager.providerCatalog.all()
      .filter((adapter) => !adapter.capacitySnapshot || adapter.capacitySnapshot().some((route) => route.maxConcurrent > 0))
      .map((adapter) => adapter.providerId);
  }

  capacitySnapshot(): Array<{ providerId: string; modelId: string; maxConcurrent: number }> {
    return this.firewallManager.providerCatalog.all().flatMap((adapter) =>
      adapter.capacitySnapshot?.().map((route) => ({ providerId: adapter.providerId, ...route })) ?? [],
    );
  }

  /**
   * Whether the live adapter for this route transmits a caller-supplied dispatch identity as a
   * provider dedupe key. When false the runtime must treat post-dispatch recovery as ambiguous.
   */
  supportsDispatchIdentity(providerId: string): boolean {
    return this.firewallManager.providerCatalog.get(providerId)?.supportsDispatchIdentity === true;
  }

  /**
   * Admission-time authority: kill switches, spend ceiling, entitlement, ForgeZero model
   * selection, provider policy, and cost ceiling. Pure — throws on denial, emits no events, so
   * it is safe to run inside a durable enqueue path before any stream exists.
   */
  async resolveHostedRoute(
    userId: string,
    request: HostedInferenceRequest,
    region: RegionResolution = REGION_UNKNOWN,
  ): Promise<HostedRouteResolution> {
    const killSwitches = this.firewallManager.getKillSwitches();
    if (!killSwitches.hostedInferenceEnabled) {
      throw new Error("Hosted inference is currently disabled by operator policy");
    }

    if (this.db) {
      const dailySpend = await this.db.getDailyProviderSpendUsd();
      if (dailySpend >= killSwitches.globalDailySpendLimitUsd) {
        throw new Error(`Global daily provider spend limit of $${killSwitches.globalDailySpendLimitUsd.toFixed(2)} reached (current: $${dailySpend.toFixed(2)})`);
      }
    }

    const activeDbCount = this.db ? await this.db.getActiveReservationCount(userId) : 0;
    const activeLocalCount = this.activeUserLeases.get(userId)?.size ?? 0;
    const activeCount = Math.max(activeDbCount, activeLocalCount);

    const estimatedInputTokens = Math.max(
      request.estimatedContextTokens || 4000,
      request.messages.reduce((total, message) => total + message.content.length, 0) + (request.tools?.length ? JSON.stringify(request.tools).length : 0),
    );
    const estimatedOutputTokens = Math.min(request.maxTokens ?? 2000, MAX_HOSTED_OUTPUT_TOKENS);
    const estimatedCredits = estimatedInputTokens + 2 * estimatedOutputTokens;
    const permission = await this.entitlementService.evaluateTaskExecution({
      userId,
      requestedEstimatedCredits: estimatedCredits,
      activeConcurrency: activeCount,
    });
    if (!permission.allowed) {
      throw new Error(permission.reason ?? "Hosted execution not permitted");
    }
    if (permission.planId === "free" && estimatedCredits > FREE_PER_TASK_CREDIT_LIMIT) {
      throw new Error(`Request estimate exceeds the 50,000 credit per-task limit (${estimatedCredits})`);
    }

    if (permission.planId === "free" && !killSwitches.hostedFreeEnabled) {
      throw new Error("CodeForge Hosted Free tier is currently disabled by operator policy");
    }

    const maxConcurrent = permission.planId === "pro" ? 4 : 1;

    // Server-side ForgeZero model selection
    let selectedProviderId = request.providerId;
    let selectedModelId = request.modelId;

    // Apply the account's privacy routing mode (STRICT / STANDARD / MAXIMUM_FREE) so the setting
    // genuinely constrains which endpoints are eligible — not a decorative control.
    const settings = this.db ? await this.db.getAccountSettings(userId) : undefined;
    const privacyMode = settings?.privacyMode;
    const privacyEligible = () =>
      privacyMode ? this.firewallManager.firewall.eligibleModels({ privacyMode }) : this.firewallManager.firewall.eligibleModels();

    if (!selectedModelId || selectedModelId === "auto" || selectedModelId === "codeforge-auto" || selectedModelId === "codeforge/forgeauto-free") {
      const decision = this.firewallManager.router.route({
        taskType: request.taskType || "coding",
        estimatedContextTokens: request.estimatedContextTokens || 4000,
        requiredCapabilities: ["text", "coding"],
        privacyMode,
      });
      if (!decision) {
        throw new Error("No verified free model is currently available in the CodeForge Cloud pool");
      }
      // Prefer the top-ranked candidate, but fall back through the router's own ranked
      // alternatives when the top pick is provider-policy-ineligible (e.g. Gemini unpaid in an
      // EEA region) — this preserves task continuity instead of failing auto-routing outright
      // (R1 remediation spec §82). The gate re-runs authoritatively below regardless of which
      // candidate is chosen here, so a wrong guess here is never a compliance risk, only a UX one.
      const rankedCandidates = [decision.model, ...decision.alternatives];
      const policyEligible = rankedCandidates.find(
        (m) =>
          (request.maxTokens === undefined || m.maxOutput === undefined || request.maxTokens <= m.maxOutput) &&
          this.firewallManager.checkProviderPolicy({ providerId: m.providerId, serviceTier: m.costProfile.isFree ? "FREE" : "PAID" }, region).decision !== "DENY",
      );
      if (!policyEligible) {
        throw new Error("No provider-policy-eligible free model is currently available for your region");
      }
      selectedProviderId = policyEligible.providerId;
      selectedModelId = policyEligible.modelId;
    } else if (!selectedProviderId) {
      // Exact model requested WITHOUT a providerId (desktop sends the bare modelId). Resolve it
      // against the privacy-filtered eligible pool — never silently substitute a different model.
      const matches = privacyEligible().filter((m) => m.modelId === selectedModelId);
      if (matches.length === 0) {
        throw new Error(`Requested hosted model '${selectedModelId}' is not currently available`);
      }
      selectedProviderId = matches[0]!.providerId;
    } else if (selectedProviderId) {
      // Exact provider+model: enforce the account's privacy mode in addition to base eligibility.
      if (privacyMode && selectedProviderId !== "gems") {
        const allowed = privacyEligible().some((m) => m.providerId === selectedProviderId && m.modelId === selectedModelId);
        if (!allowed) {
          throw new Error(`Model ${selectedProviderId}::${selectedModelId} is not permitted under your ${privacyMode} privacy mode`);
        }
      }
      // GEMS check: GEMS models are offline until real inference backend
      if (selectedProviderId === "gems") {
        throw new Error("GEMS models are currently unavailable (offline)");
      }
    }

    if (!selectedProviderId || !selectedModelId) {
      throw new Error("Could not resolve an eligible model for hosted request");
    }

    const selectedRecord = this.firewallManager.firewall.getModel(selectedProviderId, selectedModelId);
    if (selectedRecord?.maxOutput !== undefined && request.maxTokens !== undefined && request.maxTokens > selectedRecord.maxOutput) {
      throw new Error(`Requested max_tokens exceeds the selected model limit of ${selectedRecord.maxOutput}`);
    }

    const resolution: HostedRouteResolution = {
      providerId: selectedProviderId,
      modelId: selectedModelId,
      planId: permission.planId,
      maxConcurrent,
      estimatedCredits,
    };
    this.assertRouteEligible(resolution, request, region);
    return { ...resolution, accessClass: this.firewallManager.firewall.getModel(selectedProviderId, selectedModelId)?.accessClass };
  }

  /**
   * Execution-time revalidation for a route resolved earlier (e.g. a queued durable execution
   * dispatched by a worker after the original HTTP request ended). Re-runs the fail-closed
   * checks whose underlying state may have changed since enqueue: kill switches, ForgeZero
   * verification, provider policy, and the per-request cost ceiling.
   */
  assertRouteEligible(
    resolution: Pick<HostedRouteResolution, "providerId" | "modelId">,
    request: Pick<HostedInferenceRequest, "estimatedContextTokens" | "maxTokens">,
    region: RegionResolution = REGION_UNKNOWN,
  ): void {
    const killSwitches = this.firewallManager.getKillSwitches();
    if (!killSwitches.hostedInferenceEnabled) {
      throw new Error("Hosted inference is currently disabled by operator policy");
    }

    // Verify the final selection even after Auto routing or bare-model resolution.
    const verifiedModel = this.firewallManager.firewall.getModel(resolution.providerId, resolution.modelId);
    if (!verifiedModel) {
      throw new Error(`Model ${resolution.providerId}::${resolution.modelId} is not present in the ForgeZero catalog`);
    }

    if (verifiedModel.maxOutput !== undefined && request.maxTokens !== undefined && request.maxTokens > verifiedModel.maxOutput) {
      throw new Error(`Requested max_tokens exceeds the selected model limit of ${verifiedModel.maxOutput}`);
    }

    // Product/provider-policy eligibility (R1 remediation spec §8) runs before ForgeZero's
    // financial verification: it is a DIFFERENT authority (contractual/regional restriction, not
    // cost) and must be able to reject a route ForgeZero would otherwise consider $0-eligible.
    const policyDecision = this.firewallManager.checkProviderPolicy(
      { providerId: resolution.providerId, serviceTier: verifiedModel.costProfile.isFree ? "FREE" : "PAID" },
      region,
    );
    if (policyDecision.decision === "DENY") {
      throw new Error(`Model ${resolution.providerId}::${resolution.modelId} is not available under current provider policy (${policyDecision.reasonCode})`);
    }

    const verification = this.firewallManager.firewall.verify(resolution.providerId, resolution.modelId);
    if (!verification.ok) {
      throw new Error(`Model ${resolution.providerId}::${resolution.modelId} is not eligible for hosted inference: ${verification.error.message}`);
    }

    // Check the ceiling for allowance-based free capacity that exposes nominal paid rates.
    if (!verifiedModel.costProfile.isFree) {
      const estimatedTokens = (request.estimatedContextTokens || 4000) + 2000;
      const estCost = (estimatedTokens / 1_000_000) * (verifiedModel.costProfile.inputCostPerMillion || 1.0);
      if (estCost > killSwitches.maxRequestCostUsd) {
        throw new Error(`Estimated request cost of $${estCost.toFixed(2)} exceeds maximum per-request limit of $${killSwitches.maxRequestCostUsd.toFixed(2)}`);
      }
    }
  }

  /**
   * The worker-side execution phase: budget reservation, provider streaming, and usage commit
   * for a route that was already admitted. Emits non-terminal stream events only; the caller
   * owns terminalization (SSE event or durable terminal write).
   */
  async runResolvedHostedInference(
    userId: string,
    request: HostedInferenceRequest,
    resolution: HostedRouteResolution,
    onEvent: (event: HostedStreamEvent) => void,
    signal?: AbortSignal,
    dispatchId?: string,
  ): Promise<HostedInferenceOutcome> {
    const messageId = randomUUID();
    const turnId = request.turnId ?? randomUUID();
    const { providerId: selectedProviderId, modelId: selectedModelId, estimatedCredits, maxConcurrent } = resolution;

    // Acquire execution lease (process-local optimization guard)
    this.acquireLease(userId, request.requestId, maxConcurrent);
    let reservationCreated = false;

    try {
      const reservation = await this.usageEngine.reserveBudget({
        userId,
        estimatedCredits,
        requestId: request.requestId,
        providerId: selectedProviderId,
        modelId: selectedModelId,
        maxConcurrentTasks: maxConcurrent,
        freeAllowance: resolution.planId === "free",
      });
      reservationCreated = true;

      const startTime = Date.now();
      let fullText = "";
      let inputTokens = Math.ceil(request.messages.reduce((acc, m) => acc + m.content.length / 4, 0));
      let outputTokens = 0;
      // Tracked from the provider's own finish event — never inferred from whether tool
      // events happened to stream, because a provider could emit calls and still finish "stop".
      let sawToolCall = false;
      let upstreamTruncated = false;

      const adapter = this.firewallManager.providerCatalog.get(selectedProviderId);
      if (!adapter) {
        throw new Error(`Provider adapter ${selectedProviderId} is not registered in cloud pool`);
      }

      onEvent({
        type: "assistant.message.started",
        turnId,
        messageId,
        model: selectedModelId,
        provider: selectedProviderId,
      });

      // Bounded inference timeout
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => {
        timeoutController.abort(new Error(`Inference timed out after ${this.inferenceTimeoutMs}ms`));
      }, this.inferenceTimeoutMs);

      const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

      try {
        // Stream from provider. The request's maxTokens can lower the output cap but never
        // raise it past the hosted ceiling — tool arguments (file writes) routinely exceed
        // the old flat 2000, which is why the cap became negotiable with HOSTED_TOOLS.
        for await (const chunk of adapter.streamChat(
          {
            model: selectedModelId,
            messages: request.messages,
            ...(request.tools?.length ? { tools: request.tools } : {}),
            maxTokens: Math.min(request.maxTokens ?? 2000, MAX_HOSTED_OUTPUT_TOKENS),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
            ...(request.stop?.length ? { stop: request.stop } : {}),
            ...(dispatchId ? { dispatchId } : {}),
          },
          combinedSignal,
        )) {
          if (combinedSignal.aborted) {
            throw new Error(combinedSignal.reason ? String(combinedSignal.reason) : "Inference was aborted");
          }
          if (chunk.type === "text_delta" && chunk.delta) {
            fullText += chunk.delta;
            onEvent({ type: "assistant.message.delta", messageId, delta: chunk.delta });
          }
          if (chunk.type === "tool_call_started") {
            sawToolCall = true;
            onEvent({ type: "assistant.tool_call.started", messageId, toolCallId: chunk.toolCallId, toolName: chunk.toolName });
          }
          if (chunk.type === "tool_call_delta") {
            onEvent({ type: "assistant.tool_call.delta", messageId, toolCallId: chunk.toolCallId, delta: chunk.delta });
          }
          if (chunk.type === "tool_call_completed") {
            sawToolCall = true;
            onEvent({
              type: "assistant.tool_call.completed",
              messageId,
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              arguments: chunk.arguments,
            });
          }
          if (chunk.type === "finish" && chunk.finishReason === "length") {
            upstreamTruncated = true;
          }
          if (chunk.type === "usage" && chunk.usage) {
            inputTokens = chunk.usage.inputTokens ?? inputTokens;
            outputTokens = chunk.usage.outputTokens ?? outputTokens;
          }
        }

        // A cooperative adapter stops yielding on abort instead of throwing, so the loop above can
        // exit normally for a request that actually timed out or was cancelled. Without this check
        // the turn would be settled and reported as `turn.completed` — charging the user for a
        // truncated answer and hiding the timeout. Fail closed on the signal, not on the loop shape.
        if (combinedSignal.aborted) {
          throw new Error(combinedSignal.reason ? String(combinedSignal.reason) : "Inference was aborted");
        }
      } finally {
        clearTimeout(timeoutTimer);
      }

      if (outputTokens === 0) {
        outputTokens = Math.max(1, Math.ceil(fullText.length / 4));
      }

      const finishReason: HostedFinishReason = sawToolCall ? "tool_calls" : upstreamTruncated ? "length" : "stop";
      onEvent({
        type: "assistant.message.completed",
        messageId,
        fullText,
        finishReason,
        usage: { inputTokens, outputTokens },
      });

      const commit = await this.usageEngine.commitUsage({
        userId,
        requestId: request.requestId,
        reservationId: reservation.reservationId,
        estimatedCredits,
        sessionId: request.sessionId,
        turnId,
        providerId: selectedProviderId,
        modelId: selectedModelId,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        accessClass: resolution.accessClass,
        providerCostUsd: 0,
      });

      onEvent({
        type: "usage.updated",
        creditsConsumed: commit.actualCredits,
        balanceAfter: commit.balanceAfter,
      });

      return {
        messageId,
        fullText,
        finishReason,
        usage: { inputTokens, outputTokens },
        creditsConsumed: commit.actualCredits,
        balanceAfter: commit.balanceAfter,
      };
    } catch (err) {
      if (reservationCreated) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
          await this.usageEngine.releaseReservation({
            userId,
            requestId: request.requestId,
            estimatedCredits,
            reason: errorMsg,
          });
        } catch {}
      }
      throw err;
    } finally {
      this.releaseLease(userId, request.requestId);
    }
  }

  /**
   * Legacy synchronous streaming path: resolves and executes in one call. The durable hosted
   * runtime uses resolveHostedRoute at enqueue and runResolvedHostedInference inside the queue
   * worker instead; this wrapper remains for direct (non-durable) callers.
   */
  async executeHostedInference(
    userId: string,
    request: HostedInferenceRequest,
    onEvent: (event: HostedStreamEvent) => void,
    signal?: AbortSignal,
    // Sourced by the HTTP layer from trusted infrastructure only; defaults to REGION_UNKNOWN,
    // which is the safe/fail-closed value for any policy record that restricts by region.
    region: RegionResolution = REGION_UNKNOWN,
  ): Promise<{ messageId: string; fullText: string; creditsConsumed: number; balanceAfter: number }> {
    const turnId = request.turnId ?? randomUUID();
    let hasEmittedTerminalEvent = false;

    const emitTerminalEvent = (event: HostedStreamEvent) => {
      if (!hasEmittedTerminalEvent) {
        hasEmittedTerminalEvent = true;
        onEvent(event);
      }
    };

    try {
      const resolution = await this.resolveHostedRoute(userId, request, region);
      const outcome = await this.runResolvedHostedInference(userId, request, resolution, onEvent, signal);
      emitTerminalEvent({ type: "turn.completed", turnId });
      return outcome;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      emitTerminalEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw err;
    }
  }
}
