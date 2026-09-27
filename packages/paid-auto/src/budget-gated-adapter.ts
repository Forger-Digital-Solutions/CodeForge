import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderHealthResponse, ProviderModel, StreamEvent, Usage } from "@codeforge/providers";
import { paidAutoRouteFor, type PaidAutoRoute } from "./registry.js";
import {
  PaidEvaluationBudgetError,
  type PaidEvaluationBudgetGate,
  type PaidEvaluationReceipt,
  type PaidEvaluationReservation,
  type PriceCard,
} from "./evaluation-budget.js";

export interface BudgetGatedAdapterOptions {
  readonly ledger: PaidEvaluationBudgetGate;
  readonly priceCards: readonly PriceCard[];
  readonly onReceipt?: (receipt: PaidEvaluationReceipt) => void;
}

/**
 * Provider-adapter decorator that makes paid spend fail closed: every chat or stream call is
 * admitted only after the campaign ledger reserves a conservative upper bound for a registered
 * 16-Bit route with an exact CURRENT PriceCard. A successful call settles once — ACTUAL when the
 * provider reported usage, ESTIMATED_ONLY when it completed unmeasured; a call that provably did
 * no billable provider work releases its reservation. Stream receipts carry the upstream's
 * reported served-model identity when the protocol exposes one (finish-event `model`); a
 * reported identity that disagrees with the requested route fails closed exactly like chat,
 * and a missing servedModelId remains the honest "unverified" audit signal.
 */
export class BudgetGatedProviderAdapter implements ProviderAdapter {
  readonly providerId: string;
  private readonly upstream: ProviderAdapter;
  private readonly options: BudgetGatedAdapterOptions;

  constructor(upstream: ProviderAdapter, options: BudgetGatedAdapterOptions) {
    this.upstream = upstream;
    this.providerId = upstream.providerId;
    this.options = options;
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.upstream.listModels();
  }

  healthCheck(): Promise<ProviderHealthResponse> {
    return this.upstream.healthCheck();
  }

  canRoute(modelId: string): boolean {
    if (paidAutoRouteFor(this.providerId, modelId) === undefined) return false;
    return this.upstream.canRoute ? this.upstream.canRoute(modelId) : true;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { route, reservation } = await this.admit(req);
    try {
      const response = await this.upstream.chat(req);
      if (response.model !== route.providerModelId) {
        const released = await reservation.release(response.model);
        this.options.onReceipt?.(released);
        throw new PaidEvaluationBudgetError("PAID_EVALUATION_MODEL_IDENTITY_MISMATCH", "Provider served model identity did not match the exact requested route");
      }
      const receipt = await reservation.reconcile(response.usage, response.model);
      this.options.onReceipt?.(receipt);
      return response;
    } catch (error) {
      await this.releaseQuietly(reservation);
      throw error;
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { route, reservation } = await this.admit(req);
    let usage: Usage | undefined;
    let servedModelId: string | undefined;
    let settled = false;
    try {
      for await (const event of this.upstream.streamChat(req, signal)) {
        if (event.type === "usage") usage = event.usage;
        if (event.type === "finish" && event.model) servedModelId = event.model;
        yield event;
      }
      if (servedModelId !== undefined && servedModelId !== route.providerModelId) {
        const released = await reservation.release(servedModelId);
        settled = true;
        this.options.onReceipt?.(released);
        throw new PaidEvaluationBudgetError("PAID_EVALUATION_MODEL_IDENTITY_MISMATCH", "Provider served model identity did not match the exact requested route");
      }
      const receipt = await reservation.reconcile(usage, servedModelId);
      settled = true;
      this.options.onReceipt?.(receipt);
    } catch (error) {
      await this.releaseQuietly(reservation);
      settled = true;
      throw error;
    } finally {
      // A consumer that abandons the generator mid-stream must not hold the reservation open.
      if (!settled) await this.releaseQuietly(reservation);
    }
  }

  private async admit(req: ChatRequest): Promise<{ route: PaidAutoRoute; reservation: PaidEvaluationReservation }> {
    const route = paidAutoRouteFor(this.providerId, req.model);
    if (!route) {
      throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", `Paid route ${this.providerId}::${req.model} is not a registered canonical route`);
    }
    const price = this.options.priceCards.find(
      (candidate) => candidate.canonicalModelId === route.canonicalModelId && candidate.providerId === route.providerId && candidate.providerModelId === route.providerModelId,
    );
    if (!price) {
      throw new PaidEvaluationBudgetError("PAID_EVALUATION_PRICE_UNKNOWN", `No exact current PriceCard for ${route.providerId}::${route.providerModelId}`);
    }
    const correlation = typeof req.metadata?.logicalRequestId === "string" && req.metadata.logicalRequestId.length <= 80
      ? req.metadata.logicalRequestId
      : "paid";
    const reservation = await this.options.ledger.reserve(`${correlation}:${randomUUID()}`, route, price, req);
    return { route, reservation };
  }

  private async releaseQuietly(reservation: PaidEvaluationReservation): Promise<void> {
    try {
      const released = await reservation.release();
      this.options.onReceipt?.(released);
    } catch (error) {
      if (!(error instanceof PaidEvaluationBudgetError) || error.code !== "PAID_EVALUATION_RESERVATION_SETTLED") throw error;
    }
  }
}

export function createBudgetGatedAdapter(upstream: ProviderAdapter, options: BudgetGatedAdapterOptions): BudgetGatedProviderAdapter {
  return new BudgetGatedProviderAdapter(upstream, options);
}
