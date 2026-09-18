// R11.3 daily-quota reset probe for the exact frozen benchmark route.
// Never prints or persists credential material.
import fs from "node:fs/promises";

const ROUTE = "cohere/north-mini-code:free";
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not configured");

const modelsResponse = await fetch("https://openrouter.ai/api/v1/models", {
  headers: { Authorization: `Bearer ${key}` },
});
const modelsBody = await modelsResponse.json();
const route = (modelsBody.data ?? []).find((model) => model.id === ROUTE);
const pricing = route?.pricing ?? {};
const pricingAllZero = Object.values(pricing).every((value) => Number(value) === 0);
const routeExists = Boolean(route);
const routeIsFree = routeExists && pricingAllZero && String(route.id).endsWith(":free");

const completionResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: ROUTE,
    max_tokens: 512,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }),
});
const completionText = await completionResponse.text();
let completionBody;
try { completionBody = JSON.parse(completionText); } catch { completionBody = { raw: completionText.slice(0, 500) }; }
const content = completionBody?.choices?.[0]?.message?.content ?? "";
const probe = {
  schemaVersion: 1,
  probedAt: new Date().toISOString(),
  route: ROUTE,
  routeExists,
  routeIsFree,
  pricingAllZero,
  paidSubstitution: false,
  requestSucceeded: completionResponse.status === 200,
  httpStatus: completionResponse.status,
  nonemptyOutput: content.trim().length > 0,
  outputPreview: content.trim().slice(0, 80),
  rateLimitHeaders: Object.fromEntries(
    [...completionResponse.headers.entries()].filter(([name]) => /ratelimit/i.test(name)),
  ),
  errorFragment: completionResponse.status === 200
    ? undefined
    : String(completionBody?.error?.message ?? completionBody?.raw ?? "").slice(0, 300),
};

await fs.writeFile(
  new URL("./quota-reset-probe.json", import.meta.url),
  `${JSON.stringify(probe, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(probe, null, 2));
if (!probe.routeExists || !probe.routeIsFree || !probe.requestSucceeded) process.exit(1);
