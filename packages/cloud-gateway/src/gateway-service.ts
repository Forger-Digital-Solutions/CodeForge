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
      const dailySpend = this.db.getDailyProviderSpendUsd();
      if (dailySpend >= killSwitches.globalDailySpendLimitUsd) {
        const err = `Global daily provider spend limit of $${killSwitches.globalDailySpendLimitUsd.toFixed(2)} reached (current: $${dailySpend.toFixed(2)})`;
        emitTerminalEvent({ type: "turn.failed", turnId, error: err });
        throw new Error(err);
      }
    }

    // 2. Entitlement & Concurrency Check
    const activeCount = this.activeUserLeases.get(userId)?.size ?? 0;
    const permission = this.entitlementService.evaluateTaskExecution({
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

    // Acquire execution lease
    const maxConcurrent = permission.planId === "pro" ? 4 : 1;
    this.acquireLease(userId, request.requestId, maxConcurrent);

    let reservationCreated = false;
    const estimatedCredits = 5_000;

    try {
      // 3. Server-side ForgeZero Model Selection
      let selectedProviderId = request.providerId;
      let selectedModelId = request.modelId;

      if (!selectedModelId || selectedModelId === "auto") {
        const decision = this.firewallManager.router.route({
          taskType: request.taskType || "coding",
          estimatedContextTokens: request.estimatedContextTokens || 4000,
          requiredCapabilities: ["text", "coding"],
        });
        if (!decision) {
          throw new Error("No verified free model is currently available in the CodeForge Cloud pool");
        }
        selectedProviderId = decision.model.providerId;
        selectedModelId = decision.model.modelId;
      } else if (selectedProviderId) {
        // GEMS check: GEMS models are offline until real inference backend
        if (selectedProviderId === "gems") {
          throw new Error("GEMS models are currently unavailable (offline)");
        }

        const verification = this.firewallManager.firewall.verify(selectedProviderId, selectedModelId);
        if (!verification.ok) {
          throw new Error(`Model ${selectedProviderId}::${selectedModelId} is not eligible for hosted inference: ${verification.error.message}`);
        }

        // If user is Free, ensure model is actually free
        if (permission.planId === "free" && !verification.value.costProfile.isFree) {
          throw new Error("Free tier users cannot execute paid hosted models");
        }
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
      const reservation = this.usageEngine.reserveBudget({
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
      const commit = this.usageEngine.commitUsage({
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
          this.usageEngine.releaseReservation({
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
