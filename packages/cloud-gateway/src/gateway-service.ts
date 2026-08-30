import { randomUUID } from "node:crypto";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { CloudFirewallManager } from "./cloud-firewall.js";
import type { HostedInferenceRequest, HostedStreamEvent } from "./types.js";

export interface GatewayServiceConfig {
  firewallManager: CloudFirewallManager;
  entitlementService: EntitlementService;
  usageEngine: UsageEngine;
}

export class GatewayService {
  private readonly firewallManager: CloudFirewallManager;
  private readonly entitlementService: EntitlementService;
  private readonly usageEngine: UsageEngine;

  constructor(config: GatewayServiceConfig) {
    this.firewallManager = config.firewallManager;
    this.entitlementService = config.entitlementService;
    this.usageEngine = config.usageEngine;
  }

  async executeHostedInference(
    userId: string,
    request: HostedInferenceRequest,
    onEvent: (event: HostedStreamEvent) => void,
  ): Promise<{ messageId: string; fullText: string; creditsConsumed: number; balanceAfter: number }> {
    const killSwitches = this.firewallManager.getKillSwitches();
    if (!killSwitches.hostedInferenceEnabled) {
      throw new Error("Hosted inference is currently disabled by operator policy");
    }

    const turnId = request.turnId ?? randomUUID();
    const messageId = randomUUID();

    // 1. Entitlement & Concurrency Check
    const permission = this.entitlementService.evaluateTaskExecution({
      userId,
      requestedEstimatedCredits: 5_000,
    });
    if (!permission.allowed) {
      const errorMsg = permission.reason ?? "Hosted execution not permitted";
      onEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw new Error(errorMsg);
    }

    // 2. Server-side ForgeZero Model Selection
    let selectedProviderId = request.providerId;
    let selectedModelId = request.modelId;

    if (!selectedModelId || selectedModelId === "auto") {
      const decision = this.firewallManager.router.route({
        taskType: request.taskType || "coding",
        estimatedContextTokens: request.estimatedContextTokens || 4000,
        requiredCapabilities: ["text", "coding"],
      });
      if (!decision) {
        const errorMsg = "No verified free model is currently available in the CodeForge Cloud pool";
        onEvent({ type: "turn.failed", turnId, error: errorMsg });
        throw new Error(errorMsg);
      }
      selectedProviderId = decision.model.providerId;
      selectedModelId = decision.model.modelId;
    } else if (selectedProviderId) {
      const verification = this.firewallManager.firewall.verify(selectedProviderId, selectedModelId);
      if (!verification.ok) {
        const errorMsg = `Model ${selectedProviderId}::${selectedModelId} is not eligible for hosted inference: ${verification.error.message}`;
        onEvent({ type: "turn.failed", turnId, error: errorMsg });
        throw new Error(errorMsg);
      }
    }

    if (!selectedProviderId || !selectedModelId) {
      const errorMsg = "Could not resolve an eligible model for hosted request";
      onEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw new Error(errorMsg);
    }

    // 3. Two-phase budget reservation in ledger
    const estimatedCredits = 5_000;
    const reservation = this.usageEngine.reserveBudget({
      userId,
      estimatedCredits,
      requestId: request.requestId,
      providerId: selectedProviderId,
      modelId: selectedModelId,
    });

    const startTime = Date.now();
    let fullText = "";
    let inputTokens = Math.ceil(request.messages.reduce((acc, m) => acc + m.content.length / 4, 0));
    let outputTokens = 0;

    try {
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

      // Stream from provider
      for await (const chunk of adapter.streamChat({
        model: selectedModelId,
        messages: request.messages,
        maxTokens: 2000,
      })) {
        if (chunk.type === "text_delta" && chunk.delta) {
          fullText += chunk.delta;
          onEvent({ type: "assistant.message.delta", messageId, delta: chunk.delta });
        }
        if (chunk.type === "usage" && chunk.usage) {
          inputTokens = chunk.usage.inputTokens ?? inputTokens;
          outputTokens = chunk.usage.outputTokens ?? outputTokens;
        }
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

      // 4. Commit actual usage in ledger & reconcile difference
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

      onEvent({ type: "turn.completed", turnId });

      return {
        messageId,
        fullText,
        creditsConsumed: commit.actualCredits,
        balanceAfter: commit.balanceAfter,
      };
    } catch (err) {
      // 5. Release reservation on failure
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.usageEngine.releaseReservation({
        userId,
        requestId: request.requestId,
        estimatedCredits,
        reason: errorMsg,
      });
      onEvent({ type: "turn.failed", turnId, error: errorMsg });
      throw err;
    }
  }
}
