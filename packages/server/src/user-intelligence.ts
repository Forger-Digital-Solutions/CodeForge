import { createHash } from "node:crypto";
import { OpenAICompatibleAdapter, ProviderError } from "@codeforge/providers";
import type { ChatRequest, ChatResponse, CredentialStore, ProviderAdapter, ProviderCatalog, ProviderHealthResponse, ProviderModel, StreamEvent } from "@codeforge/providers";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { RosterCandidate, RosterRole } from "./forgeauto-roster.js";

/**
 * R55 wave 1 — owner-scoped USER_API intelligence sources.
 *
 * A user brings an explicit OpenAI-compatible HTTPS endpoint plus a *reference* to a
 * credential held by the trusted host (desktop secure storage). Only metadata is ever
 * persisted; the resolved key is looked up by the owning host at request time and is
 * never copied into roster state, events, errors, or work items.
 *
 * V1 boundaries: USER_API is the only executable user source class — USER_HOSTED and
 * LOCAL remain forward-compatible schema values only. User routes never pass through
 * the Free Fabric, Paid Auto, ForgeZero managed-free admission, or capacity pacing.
 */

export type UserSourceProtocol = "OPENAI_COMPATIBLE";
export type UserSourceQualification = "UNQUALIFIED" | "QUALIFIED" | "SUSPENDED";

export interface UserIntelligenceSource {
  sourceId: string;
  ownerUserId: string;
  providerId: string;
  protocol: UserSourceProtocol;
  endpointUrl: string;
  modelId: string;
  familyId: string;
  version: string;
  credentialRef: string;
  qualification: UserSourceQualification;
  qualifiedRoles: RosterRole[];
  dataPolicy: { privateCode: boolean; userConsentRequired?: boolean };
  pricing: {
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
    currency: "USD";
    confidence: "AUTHORITATIVE" | "OBSERVED" | "ESTIMATED" | "UNKNOWN";
    source?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OwnerCredentialResolver {
  get(ownerUserId: string, credentialRef: string): string | undefined;
}

const ROSTER_ROLES = new Set<RosterRole>(["EXPLORER", "PLANNER", "CODER", "TESTER", "REVIEWER", "LEAD"]);
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FIELD_LENGTH = 512;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic, collision-resistant provider identity for a user source. The id is
 * derived from the unambiguous tuple (owner, sourceId) — never user-supplied — so a
 * hostile or careless source record cannot shadow a managed provider or another owner's
 * adapter, and adjacent fields can never collide across tuple boundaries.
 */
export function userApiProviderId(ownerUserId: string, sourceId: string): string {
  return `user-api-${sha256(`${ownerUserId}\0${sourceId}`).slice(0, 24)}`;
}

/** Deterministic secure-storage key for a source's credential (desktop side). */
export function userApiCredentialRef(ownerUserId: string, sourceId: string): string {
  return `user-api-credential:${sha256(`${ownerUserId}\0${sourceId}\0credential`).slice(0, 24)}`;
}

/** Immutable runtime identity stamped on every registered USER_API adapter. */
export interface UserApiAdapterIdentity {
  ownerUserId: string;
  sourceId: string;
  /** Live qualification of the durable source record — reads reflect the latest put(). */
  qualification: UserSourceQualification;
}

const USER_API_ADAPTER_MARKER = "codeforgeUserApiSource";

/** The owner/source/qualification marker on a USER_API adapter, or undefined. */
export function userApiAdapterIdentity(adapter: ProviderAdapter | undefined): UserApiAdapterIdentity | undefined {
  const marker = (adapter as Record<string, unknown> | undefined)?.[USER_API_ADAPTER_MARKER];
  if (!marker || typeof marker !== "object") return undefined;
  const { ownerUserId, sourceId, qualification } = marker as { ownerUserId?: unknown; sourceId?: unknown; qualification?: unknown };
  if (typeof ownerUserId !== "string" || typeof sourceId !== "string") return undefined;
  if (qualification !== "UNQUALIFIED" && qualification !== "QUALIFIED" && qualification !== "SUSPENDED") return undefined;
  return Object.freeze({ ownerUserId, sourceId, qualification });
}

/** True when the catalog adapter is an R55 owner-scoped user source. */
export function isUserApiAdapter(adapter: ProviderAdapter | undefined): boolean {
  return userApiAdapterIdentity(adapter) !== undefined;
}

function fail(code: string): never {
  throw new Error(code);
}

function requireBoundedString(value: unknown, field: string, max: number = MAX_FIELD_LENGTH): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) fail(`USER_SOURCE_${field}_INVALID`);
}

function parseIpv4Literal(hostname: string): [number, number, number, number] | undefined {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return undefined;
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

/** Loopback, link-local, and private/reserved IPv4 literals — never a cloud endpoint. */
function isForbiddenIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  return a === 0 // 0.0.0.0/8 "this network"
    || a === 10 // RFC 1918
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local
    || (a === 172 && b >= 16 && b <= 31) // RFC 1918
    || (a === 192 && b === 168) // RFC 1918
    || (a === 100 && b >= 64 && b <= 127); // CGNAT shared space — not a public cloud host
}

/** IPv6 loopback (::1), link-local (fe80::/10), ULA (fc00::/7), unspecified (::). */
function isForbiddenIpv6(address: string): boolean {
  const v4Mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    const octets = parseIpv4Literal(v4Mapped[1]!);
    return octets !== undefined && isForbiddenIpv4(octets);
  }
  if (address === "::" || address === "::1") return true;
  const first = Number.parseInt(address.split(":")[0] ?? "", 16);
  if (!Number.isFinite(first)) return true; // unparseable literal is not a cloud host
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  return false;
}

/**
 * R55 USER_API endpoints are cloud-only: HTTPS, a public DNS hostname, no credentials,
 * query, fragment, or path traversal. Loopback/link-local/private literals and localhost
 * are refused — the local-inference path is a different source class that V1 does not
 * execute at all. No DNS resolution or probing is attempted.
 */
function validateEndpoint(endpointUrl: unknown): void {
  requireBoundedString(endpointUrl, "ENDPOINT", 2_048);
  // Check the raw string before URL parsing — WHATWG parsing normalizes ".." away, so a
  // traversal check on the parsed pathname alone would see only the already-collapsed path.
  if (typeof endpointUrl === "string" && (/\.\./.test(endpointUrl) || /%2e/i.test(endpointUrl) || endpointUrl.includes("\\"))) fail("USER_SOURCE_ENDPOINT_INVALID");
  let url: URL;
  try {
    url = new URL(endpointUrl as string);
  } catch {
    fail("USER_SOURCE_ENDPOINT_INVALID");
  }
  if (url!.protocol !== "https:") fail("USER_SOURCE_ENDPOINT_INVALID");
  if (url!.username || url!.password) fail("USER_SOURCE_ENDPOINT_INVALID");
  if (url!.search || url!.hash) fail("USER_SOURCE_ENDPOINT_INVALID");
  const hostname = url!.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) fail("USER_SOURCE_ENDPOINT_INVALID");
  if (hostname.startsWith("[")) {
    if (!hostname.endsWith("]") || isForbiddenIpv6(hostname.slice(1, -1))) fail("USER_SOURCE_ENDPOINT_INVALID");
  } else {
    const ipv4 = parseIpv4Literal(hostname);
    if (ipv4 !== undefined && isForbiddenIpv4(ipv4)) fail("USER_SOURCE_ENDPOINT_INVALID");
  }
  for (const segment of url!.pathname.split("/")) {
    if (!segment) continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      fail("USER_SOURCE_ENDPOINT_INVALID");
    }
    if (decoded === ".." || decoded === "." || segment.includes("\\")) fail("USER_SOURCE_ENDPOINT_INVALID");
  }
}

function validateSource(source: UserIntelligenceSource): void {
  if (!source || typeof source !== "object") fail("USER_SOURCE_INVALID");
  if (!SOURCE_ID_PATTERN.test(source.sourceId)) fail("USER_SOURCE_ID_INVALID");
  requireBoundedString(source.ownerUserId, "OWNER");
  if (source.protocol !== "OPENAI_COMPATIBLE") fail("USER_SOURCE_PROTOCOL_UNSUPPORTED_V1");
  validateEndpoint(source.endpointUrl);
  requireBoundedString(source.modelId, "MODEL");
  requireBoundedString(source.familyId, "FAMILY");
  requireBoundedString(source.version, "VERSION");
  requireBoundedString(source.credentialRef, "CREDENTIAL_REF");
  if (source.qualification !== "UNQUALIFIED" && source.qualification !== "QUALIFIED" && source.qualification !== "SUSPENDED") fail("USER_SOURCE_QUALIFICATION_INVALID");
  if (!Array.isArray(source.qualifiedRoles) || source.qualifiedRoles.some((role) => !ROSTER_ROLES.has(role)) || new Set(source.qualifiedRoles).size !== source.qualifiedRoles.length) fail("USER_SOURCE_ROLES_INVALID");
  if (!source.dataPolicy || typeof source.dataPolicy.privateCode !== "boolean") fail("USER_SOURCE_DATA_POLICY_INVALID");
  if (source.dataPolicy.userConsentRequired !== undefined && typeof source.dataPolicy.userConsentRequired !== "boolean") fail("USER_SOURCE_DATA_POLICY_INVALID");
  const pricing = source.pricing;
  if (!pricing || pricing.currency !== "USD") fail("USER_SOURCE_PRICING_INVALID");
  const validRate = (rate: unknown): boolean => rate === null || (typeof rate === "number" && Number.isFinite(rate) && rate >= 0);
  if (!validRate(pricing.inputCostPerMillion) || !validRate(pricing.outputCostPerMillion)) fail("USER_SOURCE_PRICING_INVALID");
  if (!["AUTHORITATIVE", "OBSERVED", "ESTIMATED", "UNKNOWN"].includes(pricing.confidence)) fail("USER_SOURCE_PRICING_INVALID");
  if (pricing.confidence !== "UNKNOWN" && (pricing.inputCostPerMillion === null || pricing.outputCostPerMillion === null)) fail("USER_SOURCE_PRICING_INVALID");
  if (pricing.source !== undefined && (typeof pricing.source !== "string" || pricing.source.length > MAX_FIELD_LENGTH)) fail("USER_SOURCE_PRICING_INVALID");
  // R55 wave 2: numeric rates only count as evidence when the record can say where they
  // came from — an unattributed price never becomes a spend figure.
  if (pricing.confidence !== "UNKNOWN" && (typeof pricing.source !== "string" || pricing.source.trim().length === 0)) fail("USER_SOURCE_PRICING_INVALID");
  if (Number.isNaN(Date.parse(source.createdAt)) || Number.isNaN(Date.parse(source.updatedAt))) fail("USER_SOURCE_TIMESTAMP_INVALID");
}

export class UserIntelligenceSourceStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  private key(ownerUserId: string, sourceId: string): string {
    return `user-intelligence-source-${sha256(`${ownerUserId}\0${sourceId}`)}`;
  }

  async put(ownerUserId: string, source: UserIntelligenceSource): Promise<UserIntelligenceSource> {
    if (!source || source.ownerUserId !== ownerUserId) fail("USER_SOURCE_OWNER_MISMATCH");
    validateSource(source);
    // Provider identity is derived here — a caller-supplied providerId is never trusted.
    const safe: UserIntelligenceSource = { ...source, providerId: userApiProviderId(ownerUserId, source.sourceId) };
    await this.persistence.upsertWorkItem({
      id: this.key(ownerUserId, source.sourceId),
      kind: "user_intelligence_source",
      ownerUserId,
      source: safe,
      createdAt: safe.createdAt,
      updatedAt: safe.updatedAt,
    } as unknown as WorkItem);
    return safe;
  }

  async get(ownerUserId: string, sourceId: string): Promise<UserIntelligenceSource | undefined> {
    const item = await this.persistence.getWorkItem(this.key(ownerUserId, sourceId));
    if (!item) return undefined;
    const record = item as unknown as { ownerUserId: string; source: UserIntelligenceSource };
    if (record.ownerUserId !== ownerUserId || record.source?.ownerUserId !== ownerUserId) fail("USER_SOURCE_OWNER_MISMATCH");
    return record.source;
  }

  async list(ownerUserId: string): Promise<UserIntelligenceSource[]> {
    const items = await this.persistence.getWorkItemsByKind("user_intelligence_source");
    const sources: UserIntelligenceSource[] = [];
    for (const item of items) {
      const record = item as unknown as { ownerUserId: string; source: UserIntelligenceSource };
      if (record.ownerUserId !== ownerUserId) continue;
      if (record.source?.ownerUserId !== ownerUserId) fail("USER_SOURCE_OWNER_MISMATCH");
      sources.push(record.source);
    }
    return sources;
  }
}

/**
 * Delegating guard around the OpenAI-compatible transport. Every call re-checks the
 * *current* durable source record before the wire: the source must still exist, still be
 * QUALIFIED, still carry the requested model identity, and still resolve a credential.
 * Suspending a source therefore invalidates in-flight allowances immediately — the guard
 * reads the live registry map, never a snapshot.
 */
class UserApiSourceAdapter implements ProviderAdapter {
  readonly providerId: string;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly liveSource: () => UserIntelligenceSource | undefined,
    private readonly resolveCredential: () => string | undefined,
  ) {
    this.providerId = inner.providerId;
  }

  private assertExecutable(modelId?: string): void {
    const source = this.liveSource();
    if (!source || source.qualification !== "QUALIFIED") {
      throw new ProviderError("USER_API source is not currently qualified", "USER_SOURCE_NOT_EXECUTABLE", false);
    }
    if (modelId !== undefined && modelId !== source.modelId) {
      throw new ProviderError("USER_API source model identity no longer matches the durable record", "USER_SOURCE_MODEL_MISMATCH", false);
    }
    if (this.resolveCredential() === undefined) {
      throw new ProviderError("USER_API credential reference does not resolve", "USER_CREDENTIAL_UNAVAILABLE", false);
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    this.assertExecutable();
    return this.inner.listModels();
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.assertExecutable(req.model);
    return this.inner.chat(req);
  }

  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.assertExecutable(req.model);
    return this.inner.streamChat(req, signal);
  }

  async healthCheck(): Promise<ProviderHealthResponse> {
    return this.inner.healthCheck();
  }

  canRoute(modelId: string): boolean {
    const source = this.liveSource();
    return source !== undefined && source.qualification === "QUALIFIED" && source.modelId === modelId && this.resolveCredential() !== undefined;
  }
}

/**
 * Runtime view of an owner's user intelligence sources: one guarded OpenAI-compatible
 * adapter per source registered into the shared provider catalog under the deterministic
 * providerId, plus the roster-candidate projection the roster validator/resolver see.
 * The adapter resolves its key lazily per request — a missing ref fails closed at
 * dispatch time without ever holding the value.
 */
export class UserIntelligenceRuntimeRegistry {
  private readonly store: UserIntelligenceSourceStore;
  private readonly sources = new Map<string, UserIntelligenceSource>();

  constructor(
    private readonly persistence: ISessionPersistence,
    private readonly providerCatalog: ProviderCatalog,
    private readonly credentialResolver: OwnerCredentialResolver,
    private readonly options?: { fetchFn?: typeof fetch },
  ) {
    this.store = new UserIntelligenceSourceStore(persistence);
  }

  /** Re-register adapters for every durable source after persistence init. */
  async hydrateOwner(ownerUserId: string): Promise<void> {
    for (const source of await this.store.list(ownerUserId)) this.registerAdapter(source);
  }

  async put(ownerUserId: string, source: UserIntelligenceSource): Promise<UserIntelligenceSource> {
    const stored = await this.store.put(ownerUserId, source);
    this.registerAdapter(stored);
    return stored;
  }

  async get(ownerUserId: string, sourceId: string): Promise<UserIntelligenceSource | undefined> {
    return this.store.get(ownerUserId, sourceId);
  }

  async list(ownerUserId: string): Promise<UserIntelligenceSource[]> {
    return this.store.list(ownerUserId);
  }

  private registerAdapter(source: UserIntelligenceSource): void {
    const resolver = this.credentialResolver;
    const credentialStore: CredentialStore = {
      get: () => resolver.get(source.ownerUserId, source.credentialRef),
      set: () => fail("USER_CREDENTIAL_WRITE_UNSUPPORTED"),
      delete: () => false,
      has: () => resolver.get(source.ownerUserId, source.credentialRef) !== undefined,
    };
    const inner = new OpenAICompatibleAdapter({
      providerId: source.providerId,
      baseUrl: source.endpointUrl.replace(/\/+$/, ""),
      credentialStore,
      ...(this.options?.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
    });
    const adapter = new UserApiSourceAdapter(
      inner,
      () => this.sources.get(source.providerId),
      () => resolver.get(source.ownerUserId, source.credentialRef),
    );
    // Immutable binding of owner + source identity; qualification reads stay live so a
    // SUSPENDED put() invalidates the adapter without re-registering it.
    const sources = this.sources;
    const marker: UserApiAdapterIdentity = Object.freeze({
      ownerUserId: source.ownerUserId,
      sourceId: source.sourceId,
      get qualification() {
        return sources.get(source.providerId)?.qualification ?? "SUSPENDED";
      },
    });
    Object.defineProperty(adapter, USER_API_ADAPTER_MARKER, { value: marker });
    this.providerCatalog.register(adapter);
    this.sources.set(source.providerId, source);
  }

  /**
   * Roster-safe projection: everything the roster needs to authorize and price a user
   * route, minus `credentialRef` — the ref stays inside the registry so a serialized
   * candidate or allowance can never leak where the key lives. Approved/available only
   * while QUALIFIED and the ref currently resolves; UNQUALIFIED/SUSPENDED sources stay
   * listed (visible metadata) but can never become executable.
   */
  rosterCandidates(ownerUserId: string): RosterCandidate[] {
    const candidates: RosterCandidate[] = [];
    for (const source of this.sources.values()) {
      if (source.ownerUserId !== ownerUserId) continue;
      const credentialAvailable = this.credentialResolver.get(ownerUserId, source.credentialRef) !== undefined;
      const executable = source.qualification === "QUALIFIED" && credentialAvailable;
      candidates.push({
        modelId: `${source.sourceId}/${source.modelId}`,
        providerId: source.providerId,
        providerModelId: source.modelId,
        routes: [{ providerId: source.providerId, modelId: source.modelId }],
        familyId: source.familyId,
        version: source.version,
        sourceClass: "USER_API",
        lifecycle: executable ? "ACTIVE" : "DISCOVERED",
        available: executable,
        approved: executable,
        qualifiedRoles: [...source.qualifiedRoles],
        ownerUserId: source.ownerUserId,
        sourceId: source.sourceId,
        dataPolicy: {
          privateCode: source.dataPolicy.privateCode,
          ...(source.dataPolicy.userConsentRequired !== undefined ? { userConsentRequired: source.dataPolicy.userConsentRequired } : {}),
        },
        inputCostPerMillion: source.pricing.inputCostPerMillion,
        outputCostPerMillion: source.pricing.outputCostPerMillion,
        costConfidence: source.pricing.confidence,
        ...(source.pricing.source ? { priceSource: source.pricing.source } : {}),
      });
    }
    return candidates;
  }
}
