import { randomUUID } from "node:crypto";
import type { PersonalAccountEstimate } from "@codeforge/server";
import type { PersonalPaidEstimateView } from "./paid-request-estimate-types.js";

interface EstimateSurface {
  senderId: number;
  visible: boolean;
  send(view: PersonalPaidEstimateView): void;
}

export interface PaidEstimatePresenterOptions {
  surface(): EstimateSurface | undefined;
  isCurrent(estimate: PersonalAccountEstimate): boolean;
  maskedIdentity(connectionId: string): string | undefined;
  timeoutMs?: number;
}

export class PaidEstimatePresenter {
  private readonly pending = new Map<string, { estimate: PersonalAccountEstimate; senderId: number; finish(error?: Error): void }>();
  private sequence: Promise<void> = Promise.resolve();
  constructor(private readonly options: PaidEstimatePresenterOptions) {}

  async present(estimate: PersonalAccountEstimate): Promise<void> {
    const presentation = this.sequence.then(() => this.show(estimate));
    this.sequence = presentation.catch(() => {});
    return presentation;
  }

  private async show(estimate: PersonalAccountEstimate): Promise<void> {
    const surface = this.options.surface();
    const maskedIdentity = this.options.maskedIdentity(estimate.connectionId);
    if (!surface?.visible || !maskedIdentity || !this.options.isCurrent(estimate)) throw new Error("PERSONAL_PAID_ESTIMATE_UNAVAILABLE");
    const presentationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("PERSONAL_PAID_ESTIMATE_NOT_PRESENTED")), this.options.timeoutMs ?? 10_000);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.pending.delete(presentationId);
        if (error) reject(error); else resolve();
      };
      this.pending.set(presentationId, { estimate, senderId: surface.senderId, finish });
      try {
        surface.send({ presentationId, connectionId: estimate.connectionId, providerId: estimate.providerId,
          maskedIdentity, modelId: estimate.modelId, estimatedCostUsd: estimate.estimatedCostUsd,
          remainingBudgetUsd: estimate.remainingBudgetUsd, currency: "USD", purpose: estimate.purpose });
      } catch { finish(new Error("PERSONAL_PAID_ESTIMATE_UNAVAILABLE")); }
    });
  }

  acknowledge(presentationId: unknown, senderId: number): boolean {
    if (typeof presentationId !== "string") return false;
    const pending = this.pending.get(presentationId);
    if (!pending || pending.senderId !== senderId) return false;
    const surface = this.options.surface();
    if (!surface?.visible || surface.senderId !== senderId || !this.options.isCurrent(pending.estimate)) {
      pending.finish(new Error("PERSONAL_PAID_ESTIMATE_AUTHORITY_CHANGED"));
      return false;
    }
    pending.finish();
    return true;
  }
}
