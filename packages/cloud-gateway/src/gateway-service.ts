import { randomUUID } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { CloudFirewallManager } from "./cloud-firewall.js";
import type { HostedInferenceRequest, HostedStreamEvent } from "./types.js";

export interface GatewayServiceConfig {
  firewallManager: CloudFirewallManager;
  entitlementService: EntitlementService;
  usageEngine: UsageEngine;
  db?: ICloudDatabase;
  inferenceTimeoutMs?: number;
}

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

  async executeHostedInference(
    userId: string,
    request: HostedInferenceRequest,
    onEvent: (event: HostedStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ messageId: string; fullText: string; creditsConsumed: number; balanceAfter: number }> {
    const turnId = request.turnId ?? randomUUID();
    const messageId = randomUUID();
    let hasEmittedTerminalEvent = false;

    const emitTerminalEvent = (event: HostedStreamEvent) => {
      if (!hasEmittedTerminalEvent) {
        hasEmittedTerminalEvent = true;
        onEvent(event);
      }
    };

    // 1. Check Global & Operator Kill Switches
    const killSwitches = this.firewallManager.getKillSwitches();
    if (!killSwitches.hostedInferenceEnabled) {
      const err = "Hosted inference is currently disabled by operator policy";
      emitTerminalEvent({ type: "turn.failed", turnId, error: err });
      throw new Error(err);
    }

    if (this.db) {
      const dailySpend = await this.db.getDailyProviderSpendUsd();
      if (dailySpend >= killSwitches.globalDailySpendLimitUsd) {
        const err = `Global daily provider spend limit of $${killSwitches.globalDailySpendLimitUsd.toFixed(2)} reached (current: $${dailySpend.toFixed(2)})`;
        emitTerminalEvent({ type: "turn.failed", turnId, error: err });
        throw new Error(err);
      }
    }

    // 2. Entitlement & Multi-Instance DB-Authoritative Concurrency Check
    const activeDbCount = this.db ? await this.db.getActiveReservationCount(userId) : 0;
    const activeLocalCount = this.activeUserLeases.get(userId)?.size ?? 0;
    const activeCount = Math.max(activeDbCount, activeLocalCount);

    const permission = await this.entitlementService.evaluateTaskExecution({
      userId,
      requestedEstimatedCredits: 5_000,
      activeConcurrency: activeCount,
    });
    if (!permission.allowed) {
      const errorMsg = permission.reason ?? "Hosted execution not permitted";
      emitTerminalEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw new Error(errorMsg);
    }

    // Check Free kill switch
    if (permission.planId === "free" && !killSwitches.hostedFreeEnabled) {
      const err = "CodeForge Hosted Free tier is currently disabled by operator policy";
      emitTerminalEvent({ type: "turn.failed", turnId, error: err });
      throw new Error(err);
    }

    // Acquire execution lease (process-local optimization guard)
    const maxConcurrent = permission.planId === "pro" ? 4 : 1;
    this.acquireLease(userId, request.requestId, maxConcurrent);

    let reservationCreated = false;
    const estimatedCredits = 5_000;

    try {
      // 3. Server-side ForgeZero Model Selection
      let selectedProviderId = request.providerId;
      let selectedModelId = request.modelId;

      // Apply the account's privacy routing mode (STRICT / STANDARD / MAXIMUM_FREE) so the setting
      // genuinely constrains which endpoints are eligible — not a decorative control.
      const settings = this.db ? await this.db.getAccountSettings(userId) : undefined;
      const privacyMode = settings?.privacyMode;
      const privacyEligible = () =>
        privacyMode ? this.firewallManager.firewall.eligibleModels({ privacyMode }) : this.firewallManager.firewall.eligibleModels();

      if (!selectedModelId || selectedModelId === "auto" || selectedModelId === "codeforge-auto") {
        const decision = this.firewallManager.router.route({
          taskType: request.taskType || "coding",
          estimatedContextTokens: request.estimatedContextTokens || 4000,
          requiredCapabilities: ["text", "coding"],
          privacyMode,
        });
        if (!decision) {
          throw new Error("No verified free model is currently available in the CodeForge Cloud pool");
        }
        selectedProviderId = decision.model.providerId;
        selectedModelId = decision.model.modelId;
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

        const verification = this.firewallManager.firewall.verify(selectedProviderId, selectedModelId);
        if (!verification.ok) {
          throw new Error(`Model ${selectedProviderId}::${selectedModelId} is not eligible for hosted inference: ${verification.error.message}`);
        }

        // A successful ForgeZero verification already means the model is free-eligible for the Free
        // tier — including FREE_ALLOWANCE models (Groq/Gemini) whose costProfile.isFree is false
        // because they list paid unit prices but grant a verified free allowance. We therefore trust
        // verify.ok rather than re-checking costProfile.isFree (which wrongly rejected allowance free).
      }

      if (!selectedProviderId || !selectedModelId) {
        throw new Error("Could not resolve an eligible model for hosted request");
      }

      // Check max request cost ceiling
      const verifiedModel = this.firewallManager.firewall.getModel(selectedProviderId, selectedModelId);
      if (verifiedModel && !verifiedModel.costProfile.isFree) {
        const estimatedTokens = (request.estimatedContextTokens || 4000) + 2000;
        const estCost = (estimatedTokens / 1_000_000) * (verifiedModel.costProfile.inputCostPerMillion || 1.0);
        if (estCost > killSwitches.maxRequestCostUsd) {
          throw new Error(`Estimated request cost of $${estCost.toFixed(2)} exceeds maximum per-request limit of $${killSwitches.maxRequestCostUsd.toFixed(2)}`);
        }
      }

      // 4. Two-phase budget reservation in ledger
      const reservation = await this.usageEngine.reserveBudget({
        userId,
        estimatedCredits,
        requestId: request.requestId,
        providerId: selectedProviderId,
        modelId: selectedModelId,
      });
      reservationCreated = true;

      const startTime = Date.now();
      let fullText = "";
      let inputTokens = Math.ceil(request.messages.reduce((acc, m) => acc + m.content.length / 4, 0));
      let outputTokens = 0;

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
        // Stream from provider
        for await (const chunk of adapter.streamChat(
          {
            model: selectedModelId,
            messages: request.messages,
            maxTokens: 2000,
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
          if (chunk.type === "usage" && chunk.usage) {
            inputTokens = chunk.usage.inputTokens ?? inputTokens;
            outputTokens = chunk.usage.outputTokens ?? outputTokens;
          }
        }
      } finally {
        clearTimeout(timeoutTimer);
      }

      if (outputTokens === 0) {
        outputTokens = Math.max(1, Math.ceil(fullText.length / 4));
      }

      onEvent({
        type: "assistant.message.completed",
        messageId,
        fullText,
        usage: { inputTokens, outputTokens },
      });

      // 5. Commit actual usage in ledger & reconcile difference
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
      });

      onEvent({
        type: "usage.updated",
        creditsConsumed: commit.actualCredits,
        balanceAfter: commit.balanceAfter,
      });

      emitTerminalEvent({ type: "turn.completed", turnId });

      return {
        messageId,
        fullText,
        creditsConsumed: commit.actualCredits,
        balanceAfter: commit.balanceAfter,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (reservationCreated) {
        try {
          await this.usageEngine.releaseReservation({
            userId,
            requestId: request.requestId,
            estimatedCredits,
            reason: errorMsg,
          });
        } catch {}
      }
      emitTerminalEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw err;
    } finally {
      this.releaseLease(userId, request.requestId);
    }
  }
}

