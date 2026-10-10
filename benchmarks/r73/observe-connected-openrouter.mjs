import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const digest = value => createHash("sha256").update(value).digest("hex");
const sourcePath = resolve(root, "apps/desktop/src/connected-accounts.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const privateDirectory = resolve(root, ".tmp/r73-connected-account-observation");
await mkdir(privateDirectory, { recursive: true });
const compiledPath = resolve(privateDirectory, `connected-accounts-${digest(compiled)}.mjs`);
await writeFile(compiledPath, compiled, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^@codeforge\/[a-z0-9-]+$/.test(specifier)) return nextResolve(pathToFileURL(resolve(root, "packages", specifier.slice("@codeforge/".length), "dist/index.js")).href, context);
  return nextResolve(specifier, context);
} });
const { ConnectedAccounts } = await import(pathToFileURL(compiledPath).href);
const { verifyOpenRouterEntitlement } = await import(pathToFileURL(resolve(root, "packages/providers/dist/index.js")).href);
const evidenceDirectory = resolve(root, "docs/evidence/r73-free-supply-and-completion");
const startedAt = new Date().toISOString();
const observation = {
  kind: "LIVE_ACCOUNT_METADATA_ONLY", startedAt,
  localOwnerContext: "Headless fixture owner label; does not establish desktop session authorization or encrypted storage",
  sourceHashes: { connectedAccounts: digest(source), transpiledConnectedAccounts: digest(compiled),
    openRouterEntitlement: digest(await readFile(resolve(root, "packages/providers/src/openrouter-entitlement.ts"))),
    compiledOpenRouterEntitlement: digest(await readFile(resolve(root, "packages/providers/dist/openrouter-entitlement.js"))) },
  dependencyResolution: "Every @codeforge package pinned to this R73 worktree dist, not original repository workspace symlinks",
  requests: [], inferenceRequests: 0, paidRequests: 0, accountsCreated: 0, externalAccountsTested: 0,
};
const key = process.env.OPENROUTER_API_KEY;
const approvedUrls = new Set(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"]);
const observedFetch = async (url, init) => {
  if ((init?.method ?? "GET") !== "GET" || !approvedUrls.has(String(url)) || observation.requests.length >= 2) throw new Error("R73_READ_ONLY_REQUEST_BOUND");
  const record = { method: "GET", url: String(url), startedAt: new Date().toISOString() };
  observation.requests.push(record);
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });
    record.status = response.status; record.completedAt = new Date().toISOString(); return response;
  } catch { record.failed = true; record.completedAt = new Date().toISOString(); throw new Error("READ_ONLY_TRANSPORT_FAILED"); }
};
try {
  if (!key?.trim()) {
    observation.status = "ENVIRONMENT_CREDENTIAL_UNAVAILABLE";
  } else {
    let settings = {};
    const secrets = new Map();
    const host = {
      ownerUserId: () => "r73-headless-auth-validation",
      readSettings: () => settings,
      writeSettings: next => { settings = next; },
      secrets: { get: ref => secrets.get(ref), set: (ref, value) => { secrets.set(ref, value); }, delete: ref => { secrets.delete(ref); } },
      providerName: id => id === "openrouter" ? "OpenRouter" : undefined,
      probe: async (providerId, fields) => {
        if (providerId !== "openrouter" || fields.apiKey !== key) throw new Error("AUTHORIZATION_CONTEXT_MISMATCH");
        const response = await observedFetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` } });
        if (!response.ok) throw new Error("CATALOG_UNAVAILABLE");
        const catalog = await response.json();
        if (!Array.isArray(catalog?.data)) throw new Error("CATALOG_INVALID");
        const models = catalog.data.filter(entry => typeof entry?.id === "string").map(entry => ({ modelId: entry.id, displayName: typeof entry.name === "string" ? entry.name : entry.id,
          isFree: false, freeStatus: "unverified", capabilities: { text: true, coding: false, toolCalling: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools"), vision: false,
            structuredOutput: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("response_format"), longContext: false } }));
        observation.catalogModelsObserved = models.length;
        observation.modelsQualified = 0;
        return { values: { apiKey: key }, models };
      },
      verifyOpenRouter: options => verifyOpenRouterEntitlement({ ...options, fetchFn: observedFetch }),
    };
    const accounts = new ConnectedAccounts(host);
    const result = await accounts.connect("openrouter", { apiKey: key }, { authMethod: "ENVIRONMENT", label: "Read-only metadata validation" });
    observation.connectionAccepted = result.ok;
    observation.connectionError = result.ok ? undefined : "SUPPORTED_CONNECTION_VALIDATION_FAILED";
    if (result.ok && result.connection) {
      observation.externalAccountsTested = 1;
      const connectionId = result.connection.connectionId;
      const authority = accounts.authority(connectionId);
      observation.accountClass = authority?.accountClass;
      observation.authState = authority?.authState;
      observation.quotaScopeVerified = authority?.quotaScopeVerified;
      observation.quotaScope = authority?.quotaScopeEvidence?.scope;
      observation.identityPresent = !!authority?.accountIdentityHash;
      observation.zeroCostCertificate = authority?.freeAdmissionVerified === true;
      observation.defaultPaidSpendingEnabled = result.connection.paidSpendingEnabled;
      observation.defaultPaidDispatchEligible = result.connection.paidDispatchEligible;
      observation.freeOnlyCredentialAvailable = accounts.credentials(connectionId, "FREE_ONLY") !== undefined;
      observation.personalPaidCredentialAvailable = accounts.credentials(connectionId, "PERSONAL_PAID") !== undefined;
      observation.status = authority?.accountClass === "PAID" && authority.authState === "ok" && !observation.freeOnlyCredentialAvailable && !observation.personalPaidCredentialAvailable
        ? "LIVE_PAID_ACCOUNT_CONNECTED_FREE_ONLY_DENIED_DEFAULT_PAID_OFF"
        : "OBSERVED_ACCOUNT_NOT_THE_EXPECTED_PAID_ADMISSION_PROOF";
      const restarted = new ConnectedAccounts(host);
      observation.restartConnectionPreserved = restarted.list().some(account => account.connectionId === connectionId && account.connected);
      observation.restartRequiresRecheck = restarted.authority(connectionId)?.authState === "unknown";
      observation.restartCredentialDispatchAvailable = restarted.credentials(connectionId, "FREE_ONLY") !== undefined || restarted.credentials(connectionId, "PERSONAL_PAID") !== undefined;
      await accounts.disconnect(connectionId);
      observation.localDisconnectRemovesCredential = secrets.size === 0;
      observation.localDisconnectBlocksCredentialDispatch = accounts.credentials(connectionId, "FREE_ONLY") === undefined && accounts.credentials(connectionId, "PERSONAL_PAID") === undefined;
      observation.publicViewContainsSecrets = JSON.stringify(accounts.list()).includes(key);
    } else observation.status = "LIVE_CONNECTION_AUTHORIZATION_UNPROVEN";
    secrets.clear(); settings = {};
  }
} catch { observation.status = "READ_ONLY_OBSERVATION_FAILED"; }
observation.completedAt = new Date().toISOString();
await mkdir(evidenceDirectory, { recursive: true });
const file = resolve(evidenceDirectory, `openrouter-connected-account-metadata-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ file, status: observation.status, requests: observation.requests.length, accountClass: observation.accountClass, inferenceRequests: observation.inferenceRequests, connectionAccepted: observation.connectionAccepted }));
