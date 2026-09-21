import { z } from "zod";
import type { MeasuredNumber, ModelCallRecord } from "./run-record.js";
import { derived, measured, unknownMetric } from "./run-record.js";

/**
 * Frozen pricing snapshot and cost conversion (protocol §11).
 *
 * `actual_cost` is what the run cost CodeForge; `equivalent_public_api_cost` is what the same
 * tokens would cost at the snapshot's paid listing of the same model (or its declared proxy);
 * `equivalent_market_cost` prices the same tokens at a named reference frontier model. The three
 * are never conflated. Every conversion cites the snapshot id and price reference it used.
 */

export const PriceEntrySchema = z.object({
  /** Canonical `${providerId}::${modelId}` of the priced listing. */
  id: z.string(),
  displayName: z.string().optional(),
  inputPerMillionUsd: z.number().nonnegative(),
  outputPerMillionUsd: z.number().nonnegative(),
  /** Price for prompt tokens the provider served from cache; absent → priced at the input rate (stated). */
  cacheReadPerMillionUsd: z.number().nonnegative().optional(),
  /** Reasoning tokens are billed as output on every provider in the snapshot unless stated. */
  reasoningPerMillionUsd: z.number().nonnegative().optional(),
  source: z.string(),
  retrievedAt: z.string(),
});
export type PriceEntry = z.infer<typeof PriceEntrySchema>;

export const PricingSnapshotSchema = z.object({
  snapshotId: z.string(),
  frozenAt: z.string(),
  currency: z.literal("USD"),
  /** Route id (`provider::model`) → the paid listing used as its public-API equivalent, with the reason. */
  equivalents: z.record(z.object({ priceRef: z.string(), rationale: z.string() })),
  /** The named reference frontier model used for `equivalent_market_cost`. */
  marketReference: z.object({ priceRef: z.string(), rationale: z.string() }),
  prices: z.record(PriceEntrySchema),
});
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

export function parsePricingSnapshot(raw: unknown): PricingSnapshot {
  const snapshot = PricingSnapshotSchema.parse(raw);
  for (const [route, equivalent] of Object.entries(snapshot.equivalents)) {
    if (!snapshot.prices[equivalent.priceRef]) throw new Error(`pricing snapshot ${snapshot.snapshotId}: equivalent for ${route} references unknown price ${equivalent.priceRef}`);
  }
  if (!snapshot.prices[snapshot.marketReference.priceRef]) throw new Error(`pricing snapshot ${snapshot.snapshotId}: market reference ${snapshot.marketReference.priceRef} is not priced`);
  return snapshot;
}

/**
 * Exact cost of a token bundle at a price entry. Arithmetic is done in integer micro-dollars per
 * million tokens to avoid floating drift, then converted once.
 */
export function priceTokens(totals: TokenTotals, price: PriceEntry): { usd: number; breakdown: { inputUsd: number; cachedUsd: number; outputUsd: number; reasoningUsd: number }; note: string } {
  const cached = Math.min(totals.cachedPromptTokens ?? 0, totals.promptTokens);
  const uncached = totals.promptTokens - cached;
  const reasoning = totals.reasoningTokens ?? 0;
  const cacheRate = price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd;
  const reasoningRate = price.reasoningPerMillionUsd ?? price.outputPerMillionUsd;
  const micro = (tokens: number, ratePerMillion: number) => Math.round(tokens * ratePerMillion * 1_000_000) / 1_000_000; // exact to 1e-6 USD per token-million
  const inputUsd = micro(uncached, price.inputPerMillionUsd) / 1_000_000;
  const cachedUsd = micro(cached, cacheRate) / 1_000_000;
  // Providers count reasoning tokens inside completion tokens on OpenAI-compatible routes; the
  // snapshot's reasoning rate applies only to the *difference* when a separate rate exists.
  const outputUsd = micro(totals.completionTokens, price.outputPerMillionUsd) / 1_000_000;
  const reasoningUsd = price.reasoningPerMillionUsd !== undefined ? micro(reasoning, reasoningRate - price.outputPerMillionUsd) / 1_000_000 : 0;
  const usd = round9(inputUsd + cachedUsd + outputUsd + reasoningUsd);
  const note = price.cacheReadPerMillionUsd === undefined && cached > 0 ? "cached tokens priced at the input rate (no cache-read price in snapshot)" : "";
  return { usd, breakdown: { inputUsd: round9(inputUsd), cachedUsd: round9(cachedUsd), outputUsd: round9(outputUsd), reasoningUsd: round9(reasoningUsd) }, note };
}

function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export function sumTokenTotals(calls: readonly ModelCallRecord[]): TokenTotals | undefined {
  const reported = calls.filter((call) => call.usageSource === "PROVIDER_REPORTED");
  if (reported.length === 0 || reported.length !== calls.length) return undefined;
  const totals: TokenTotals = { promptTokens: 0, completionTokens: 0 };
  let cachedKnown = true;
  let reasoningKnown = true;
  let cached = 0;
  let reasoning = 0;
  for (const call of reported) {
    totals.promptTokens += call.promptTokens ?? 0;
    totals.completionTokens += call.completionTokens ?? 0;
    if (call.cachedPromptTokens === undefined) cachedKnown = false;
    else cached += call.cachedPromptTokens;
    if (call.reasoningTokens === undefined) reasoningKnown = false;
    else reasoning += call.reasoningTokens;
  }
  if (cachedKnown) totals.cachedPromptTokens = cached;
  if (reasoningKnown) totals.reasoningTokens = reasoning;
  return totals;
}

export interface EconomicsResult {
  pricingSnapshotId: string;
  actualCostUsd: MeasuredNumber;
  equivalentPublicApiCostUsd: MeasuredNumber;
  equivalentPublicApiPriceRef: string;
  equivalentMarketCostUsd: MeasuredNumber;
  equivalentMarketPriceRef: string;
}

/**
 * Economics for one run. `routeId` is `${providerId}::${modelId}` of the route actually used;
 * `routeListedUnitPrice` is the route's own listed price (e.g. `$0/$0` on a `:free` route) used
 * to DERIVE actual cost when the provider did not report a per-call cost.
 */
export function computeEconomics(
  calls: readonly ModelCallRecord[],
  routeId: string,
  snapshot: PricingSnapshot,
  routeListedUnitPrice?: { inputPerMillionUsd: number; outputPerMillionUsd: number },
): EconomicsResult {
  const totals = sumTokenTotals(calls);
  const equivalent = snapshot.equivalents[routeId];
  const equivalentRef = equivalent?.priceRef ?? "";
  const marketRef = snapshot.marketReference.priceRef;

  let actual: MeasuredNumber;
  const allReported = calls.length > 0 && calls.every((call) => call.usageSource !== "PROVIDER_REPORTED" || call.providerReportedCostUsd !== undefined) && calls.some((call) => call.providerReportedCostUsd !== undefined);
  if (allReported) {
    actual = measured(round9(calls.reduce((sum, call) => sum + (call.providerReportedCostUsd ?? 0), 0)), "PROVIDER", "Σ provider-reported per-call cost");
  } else if (totals && routeListedUnitPrice) {
    const priced = priceTokens(totals, { id: routeId, inputPerMillionUsd: routeListedUnitPrice.inputPerMillionUsd, outputPerMillionUsd: routeListedUnitPrice.outputPerMillionUsd, source: "route listed unit price", retrievedAt: snapshot.frozenAt });
    actual = derived(priced.usd, "SNAPSHOT", "tokens × route listed unit price");
  } else {
    actual = unknownMetric(totals ? "no provider cost and no listed unit price" : "token totals unknown");
  }

  const publicEq: MeasuredNumber = totals && equivalent
    ? derived(priceTokens(totals, snapshot.prices[equivalent.priceRef]!).usd, "SNAPSHOT", `tokens × ${equivalent.priceRef}`)
    : unknownMetric(totals ? `no public-API equivalent declared for ${routeId}` : "token totals unknown");
  const marketEq: MeasuredNumber = totals
    ? derived(priceTokens(totals, snapshot.prices[marketRef]!).usd, "SNAPSHOT", `tokens × ${marketRef}`)
    : unknownMetric("token totals unknown");

  return {
    pricingSnapshotId: snapshot.snapshotId,
    actualCostUsd: actual,
    equivalentPublicApiCostUsd: publicEq,
    equivalentPublicApiPriceRef: equivalentRef,
    equivalentMarketCostUsd: marketEq,
    equivalentMarketPriceRef: marketRef,
  };
}
