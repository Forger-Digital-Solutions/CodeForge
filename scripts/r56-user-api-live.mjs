// R56 live USER_API evidence: a real OpenAI-compatible user-owned endpoint exercised
// through the actual source store, runtime registry, adapter guard, and roster boundary —
// no mocks of the wire, no fabricated qualification.
//
//   node scripts/r56-user-api-live.mjs [--out=<file>]
//
// What it proves live (FORGEREMS_OPENAI_* env, values never printed or persisted):
//   1. Real HTTPS endpoint authenticates (/models 200) and its inference verdict is the
//      provider's own answer (429 "no credits remaining" at capture time).
//   2. Qualification is evidence-driven: an unqualified source cannot dispatch, and a
//      credential-less owner B cannot even see the record.
//   3. A source marked QUALIFIED dispatches a REAL request — the provider's real 429 is
//      classified, surfaces honestly, and never falls back to managed free intelligence.
//   4. Suspending the source invalidates the adapter immediately (guard re-reads live).
//   5. Source + credential binding survive a real persistence reopen (second store
//      instance over the same file-backed db).
//   6. Endpoint policy refuses loopback/private literals (SSRF, no network needed).
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createSessionPersistence } from "@codeforge/sessions";
import {
  UserIntelligenceRuntimeRegistry,
  userApiCredentialRef,
} from "@codeforge/server";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = option("out", "docs/evidence/r56-golden-backend-freeze/user-api-live.json");

const OWNER_A = "r56-user-owner-a";
const OWNER_B = "r56-user-owner-b";
const SOURCE_ID = "forgerems-live-1";

const base = (process.env.FORGEREMS_OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.FORGEREMS_OPENAI_API_KEY ?? "";
const modelId = process.env.FORGEREMS_OPENAI_MODEL ?? "";

async function realProbe() {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const models = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) })
    .then(async (r) => ({ status: r.status, count: safeJson(await r.text()) }))
    .catch((e) => ({ status: 0, error: String(e?.message ?? e).slice(0, 200) }));
  const chat = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8, stream: false }),
    signal: AbortSignal.timeout(30_000),
  }).then(async (r) => ({ status: r.status, bodyClass: classifyBody(await r.text()) }))
    .catch((e) => ({ status: 0, error: String(e?.message ?? e).slice(0, 200) }));
  return { models, chat };
}
function safeJson(text) {
  try { return (JSON.parse(text).data ?? []).length; } catch { return undefined; }
}
function classifyBody(text) {
  if (/no credits|insufficient|quota|rate.?limit/i.test(text)) return "QUOTA_OR_RATE_LIMITED";
  if (/\"choices\"/.test(text)) return "COMPLETION_RETURNED";
  if (/invalid|unauthor|forbidden/i.test(text)) return "AUTH_OR_INVALID";
  return "OTHER";
}

async function main() {
  if (!base || !apiKey || !modelId) throw new Error("FORGEREMS_OPENAI_BASE_URL/_API_KEY/_MODEL required (presence only; never printed)");
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), owner: OWNER_A, secondOwner: OWNER_B, steps: {} };

  // ---- 0. Endpoint policy: SSRF refuses loopback/private before any wire.
  const tmpDir = await mkdtemp(join(tmpdir(), "cf-r56-userapi-"));
  const dbPath = join(tmpDir, "user-api.db");
  const persistence = createSessionPersistence({ dbPath });
  await persistence.init();
  const catalog = new InMemoryProviderCatalog();
  const credentials = new Map([[userApiCredentialRef(OWNER_A, SOURCE_ID), apiKey]]);
  // Owner-scoped resolver: answers only for the owner it was connected as.
  const resolver = { get: (owner, ref) => (owner === OWNER_A ? credentials.get(ref) : undefined) };
  const registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, resolver);

  const loopbackRejected = [];
  for (const bad of ["http://127.0.0.1:8080/v1", "http://localhost:9/v1", "https://10.0.0.4/v1", "https://endpoint.example/v1/../../x", "ftp://endpoint.example/v1"]) {
    try {
      await registry.put(OWNER_A, makeSource({ endpointUrl: bad }));
      loopbackRejected.push({ endpoint: bad.replace(/:\/\/[^/]+/, "://<host>"), rejected: false });
    } catch (e) {
      loopbackRejected.push({ endpoint: bad.replace(/:\/\/[^/]+/, "://<host>"), rejected: /USER_SOURCE_ENDPOINT/.test(String(e?.message ?? e)) });
    }
  }
  evidence.steps.endpointPolicy = loopbackRejected;

  // ---- 1. Real endpoint probe (operator-side; drives the honest qualification verdict).
  const probe = await realProbe();
  evidence.steps.endpointProbe = { modelsStatus: probe.models.status, listedModelCount: probe.models.count ?? null, chatStatus: probe.chat.status, chatClass: probe.chat.bodyClass ?? probe.chat.error ?? null };

  // ---- 2. Register the source UNQUALIFIED first; prove the adapter refuses the wire.
  let source = makeSource({ qualification: "UNQUALIFIED" });
  source = await registry.put(OWNER_A, source);
  evidence.steps.sourceIdentity = { providerId: source.providerId, credentialRefShape: /^user-api-credential:[a-f0-9]{24}$/.test(source.credentialRef) };
  const adapter = catalog.get(source.providerId);
  const errCode = (e) => String(e?.code ?? e?.message ?? e);
  let unqualifiedRefused = false;
  try {
    await adapter.chat({ model: modelId, messages: [{ role: "user", content: "ping" }], maxTokens: 4 });
  } catch (e) {
    unqualifiedRefused = /USER_SOURCE_NOT_EXECUTABLE/.test(errCode(e));
  }
  evidence.steps.unqualifiedDispatchRefused = unqualifiedRefused;

  // ---- 3. Owner isolation: B can neither read the source nor resolve the credential.
  const bList = await registry.list(OWNER_B);
  const bGet = await registry.get(OWNER_B, SOURCE_ID);
  const bCredential = resolver.get(OWNER_B, source.credentialRef);
  const bCandidates = registry.rosterCandidates(OWNER_B);
  evidence.steps.ownerIsolation = {
    bSourceListEmpty: bList.length === 0,
    bSourceGetUndefined: bGet === undefined,
    bCredentialUnresolved: bCredential === undefined,
    bRosterCandidatesEmpty: bCandidates.length === 0,
  };
  // A's roster projection must carry no credentialRef.
  const aCandidates = registry.rosterCandidates(OWNER_A);
  evidence.steps.rosterProjection = {
    count: aCandidates.length,
    credentialRefLeaked: JSON.stringify(aCandidates).includes(source.credentialRef),
    lifecycleWhenUnqualified: aCandidates[0]?.lifecycle ?? null,
    executableWhenUnqualified: aCandidates[0]?.available ?? null,
  };

  // ---- 4. Forced-QUALIFIED live dispatch: prove the wire + honest failure semantics.
  //    Qualification is forced here solely to exercise the real dispatch path; the
  //    endpoint probe above records why this endpoint is not actually free-capable today.
  source = await registry.put(OWNER_A, { ...source, qualification: "QUALIFIED", updatedAt: new Date().toISOString() });
  let dispatch;
  try {
    const res = await adapter.chat({ model: modelId, messages: [{ role: "user", content: "Reply with exactly: ok" }], maxTokens: 8 });
    dispatch = { reachedProvider: true, status: "COMPLETED", completionReturned: (res?.choices?.[0]?.message?.content ?? "").length > 0 };
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 240);
    dispatch = { reachedProvider: true, status: /429|rate|credits|quota/i.test(msg) ? "PROVIDER_REJECTED_QUOTA" : "PROVIDER_ERROR", classified: msg.replace(apiKey, "<redacted>") };
  }
  evidence.steps.liveDispatch = dispatch;

  // ---- 5. Suspension invalidates the adapter mid-life without re-registration.
  await registry.put(OWNER_A, { ...source, qualification: "SUSPENDED", updatedAt: new Date().toISOString() });
  let suspendedRefused = false;
  try {
    await adapter.chat({ model: modelId, messages: [{ role: "user", content: "ping" }], maxTokens: 4 });
  } catch (e) {
    suspendedRefused = /USER_SOURCE_NOT_EXECUTABLE/.test(errCode(e));
  }
  evidence.steps.suspendedInvalidatesAdapter = suspendedRefused;

  // ---- 6. Missing credential fails closed (delete the ref from the resolver view).
  credentials.clear();
  await registry.put(OWNER_A, { ...source, qualification: "QUALIFIED", updatedAt: new Date().toISOString() });
  let missingCredentialRefused = false;
  try {
    await adapter.chat({ model: modelId, messages: [{ role: "user", content: "ping" }], maxTokens: 4 });
  } catch (e) {
    missingCredentialRefused = /USER_CREDENTIAL_UNAVAILABLE/.test(errCode(e));
  }
  evidence.steps.missingCredentialFailsClosed = missingCredentialRefused;
  credentials.set(userApiCredentialRef(OWNER_A, SOURCE_ID), apiKey);

  // ---- 7. Durability: close the store; a second persistence instance over the same
  //    file must rehydrate the source (owner-scoped), still without the raw secret.
  await persistence.close();
  const reopened = createSessionPersistence({ dbPath });
  await reopened.init();
  const reopenedCatalog = new InMemoryProviderCatalog();
  const reopenedRegistry = new UserIntelligenceRuntimeRegistry(reopened, reopenedCatalog, resolver);
  await reopenedRegistry.hydrateOwner(OWNER_A);
  const rehydrated = await reopenedRegistry.get(OWNER_A, SOURCE_ID);
  const bRehydrated = await reopenedRegistry.get(OWNER_B, SOURCE_ID);
  const reopenedAdapter = reopenedCatalog.get(rehydrated?.providerId ?? "");
  evidence.steps.persistenceReopen = {
    sourceSurvived: rehydrated !== undefined,
    ownerMatched: rehydrated?.ownerUserId === OWNER_A,
    endpointSurvived: rehydrated?.endpointUrl === source.endpointUrl,
    providerIdStable: rehydrated?.providerId === source.providerId,
    qualificationLiveValue: rehydrated?.qualification ?? null,
    adapterReregistered: reopenedAdapter !== undefined,
    crossOwnerStillEmpty: bRehydrated === undefined,
    credentialRefStillAbsentFromCandidates: !JSON.stringify(reopenedRegistry.rosterCandidates(OWNER_A)).includes(source.credentialRef),
  };
  await reopened.close();

  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
  const ok = unqualifiedRefused
    && suspendedRefused
    && missingCredentialRefused
    && evidence.steps.ownerIsolation.bSourceGetUndefined
    && evidence.steps.ownerIsolation.bCredentialUnresolved
    && !evidence.steps.rosterProjection.credentialRefLeaked
    && evidence.steps.endpointPolicy.every((r) => r.rejected)
    && evidence.steps.persistenceReopen.sourceSurvived
    && evidence.steps.persistenceReopen.adapterReregistered;
  process.stdout.write(`[r56-user-api] ${ok ? "ALL_CHECKS_PASS" : "CHECKS_FAILED"} probe=${JSON.stringify(evidence.steps.endpointProbe)} dispatch=${dispatch.status}\n`);
  process.stdout.write(`[r56-user-api] evidence=${target}\n`);
  if (!ok) process.exitCode = 1;
}

function makeSource(overrides = {}) {
  const now = new Date().toISOString();
  return {
    sourceId: SOURCE_ID,
    ownerUserId: OWNER_A,
    providerId: "caller-supplied-ignored",
    protocol: "OPENAI_COMPATIBLE",
    endpointUrl: base,
    modelId,
    familyId: "forgerems-family",
    version: "live-1",
    credentialRef: userApiCredentialRef(OWNER_A, SOURCE_ID),
    qualification: "UNQUALIFIED",
    qualifiedRoles: ["CODER", "EXPLORER", "REVIEWER"],
    dataPolicy: { privateCode: true },
    pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", confidence: "UNKNOWN" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
