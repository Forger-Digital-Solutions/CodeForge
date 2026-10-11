import type {
  ForgeAaaCandidateClass,
  ForgeAaaCandidateKind,
  ForgeAaaDomain,
  ForgeAaaEngineTarget,
  ForgeAaaLeadIdentity,
  ForgeAaaSpecialtyId,
} from "./types.js";

/**
 * A discovered specialist or lead candidate (mission §4). `provider` facts are only ever
 * populated from real provider/catalog evidence — a famous product name with no verified
 * route stays UNAVAILABLE rather than gaining an invented identifier.
 */
export interface ForgeAaaCandidate {
  id: string;
  displayName: string;
  kind: ForgeAaaCandidateKind;
  /** "lead" entries are frontier reasoning models; otherwise the specialties served. */
  serves: readonly (ForgeAaaSpecialtyId | "lead")[];
  domain: ForgeAaaDomain;
  engines: readonly ForgeAaaEngineTarget[];
  provider?: {
    providerId: string;
    providerModelId?: string;
    endpoint?: string;
    /** Binds this candidate to a named lead identity — set only on verified bindings. */
    leadIdentity?: ForgeAaaLeadIdentity;
  };
  access: {
    auth: "none" | "api_key" | "oauth" | "local_install" | "unknown";
    costClass: "free" | "paid" | "self_hosted" | "unknown";
    quota?: string;
  };
  license: { commercialUse: "yes" | "no" | "conditional" | "unknown"; detail?: string };
  formats?: readonly string[];
  vramMb?: number;
  maturity: "stable" | "beta" | "research" | "unknown";
  /** Static classification before runtime qualification evidence is applied. */
  classification: ForgeAaaCandidateClass;
  /** Honest reason for the classification, shown to the user verbatim. */
  statusDetail: string;
  /** What would move this candidate forward — the next executable verification step. */
  nextStep?: string;
  dataPolicy?: { sendsPrivateContent: boolean; trains?: boolean };
}

const namedLeadUnavailable = "Named ForgeAAA lead target — provider model id, endpoint compatibility, and account entitlement are unverified. No provider identifier is invented; routing fails closed until a connected provider actually reports this model.";

/**
 * Seed registry. Every external product starts UNAVAILABLE: registration records the
 * intent to investigate, never a working integration. Promotion requires real execution
 * evidence recorded through ForgeAaaRegistry.recordQualification.
 */
export const FORGE_AAA_SEED_CANDIDATES: readonly ForgeAaaCandidate[] = [
  {
    id: "lead/gpt-6.1-sol", displayName: "GPT-6.1 Sol", kind: "lead_model", serves: ["lead"],
    domain: "managed_paid", engines: ["any"], maturity: "unknown",
    access: { auth: "unknown", costClass: "paid" },
    license: { commercialUse: "unknown" },
    classification: "UNAVAILABLE", statusDetail: namedLeadUnavailable,
    nextStep: "Connect a provider account that reports this model; verify provider model id, pricing, and entitlement.",
  },
  {
    id: "lead/claude-opus-5.5", displayName: "Claude Opus 5.5", kind: "lead_model", serves: ["lead"],
    domain: "managed_paid", engines: ["any"], maturity: "unknown",
    access: { auth: "unknown", costClass: "paid" },
    license: { commercialUse: "unknown" },
    classification: "UNAVAILABLE", statusDetail: namedLeadUnavailable,
    nextStep: "Connect a provider account that reports this model; verify provider model id, pricing, and entitlement.",
  },
  {
    id: "tool/blender-adapter", displayName: "Blender 4.5 headless adapter", kind: "local_tool",
    serves: ["forge-modeler", "forge-material", "forge-world", "forge-character", "forge-optimizer", "forge-verify"],
    domain: "local_tool", engines: ["blender-4.5"], maturity: "stable",
    access: { auth: "local_install", costClass: "free" },
    license: { commercialUse: "yes", detail: "Blender is GPL; generated assets and scripts are user-owned." },
    formats: ["blend", "fbx", "gltf", "obj", "stl"],
    classification: "EXPERIMENTAL",
    statusDetail: "First-party adapter; promoted to INTEGRATED only after a real headless execution is recorded on this host.",
    nextStep: "Run detection + one bounded headless script execution.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "tool/unreal-adapter", displayName: "Unreal Engine 4.27 adapter", kind: "local_tool",
    serves: ["forge-gameplay", "forge-world", "forge-atmosphere", "forge-simulation", "forge-cinematic", "forge-optimizer", "forge-verify", "forge-material", "forge-audio"],
    domain: "local_tool", engines: ["ue-4.27"], maturity: "stable",
    access: { auth: "local_install", costClass: "free" },
    license: { commercialUse: "conditional", detail: "Unreal Engine EULA — royalty terms apply to shipped products; tooling use is unrestricted." },
    formats: ["uasset", "umap", "fbx", "wav", "png"],
    classification: "EXPERIMENTAL",
    statusDetail: "First-party adapter; detection and capability negotiation are real, editor ops require an authorized project and bounded launch.",
    nextStep: "Detect install, negotiate version capabilities, run one bounded commandlet or editor-script op.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "svc/meshy", displayName: "Meshy AI 3D generation", kind: "hosted_service",
    serves: ["forge-modeler"], domain: "external_service", engines: ["blender-4.5"], maturity: "stable",
    access: { auth: "api_key", costClass: "paid", quota: "per-tier quota" },
    license: { commercialUse: "conditional", detail: "Commercial use requires a paid Meshy plan; verify current terms." },
    formats: ["fbx", "glb", "obj", "stl"],
    classification: "UNAVAILABLE",
    statusDetail: "API reachable in principle; no credential configured, no execution evidence. Requires explicit paid-service authorization before use.",
    nextStep: "User supplies API key + spend authorization; run a bounded probe generation.",
    dataPolicy: { sendsPrivateContent: true },
  },
  {
    id: "svc/tripo", displayName: "Tripo3D generation", kind: "hosted_service",
    serves: ["forge-modeler"], domain: "external_service", engines: ["blender-4.5"], maturity: "stable",
    access: { auth: "api_key", costClass: "paid", quota: "credit-based" },
    license: { commercialUse: "conditional", detail: "Commercial use subject to Tripo plan terms." },
    formats: ["glb", "fbx", "obj"],
    classification: "UNAVAILABLE",
    statusDetail: "No credential configured; no execution evidence.",
    nextStep: "User supplies API key + spend authorization; run a bounded probe generation.",
    dataPolicy: { sendsPrivateContent: true },
  },
  {
    id: "ow/hunyuan3d", displayName: "Hunyuan3D (open weights)", kind: "open_weight",
    serves: ["forge-modeler"], domain: "local_tool", engines: ["blender-4.5"], maturity: "research",
    access: { auth: "local_install", costClass: "self_hosted" },
    license: { commercialUse: "conditional", detail: "Tencent Hunyuan community license — verify current terms before commercial redistribution." },
    formats: ["glb", "obj"],
    vramMb: 10240,
    classification: "UNAVAILABLE",
    statusDetail: "Weights are public but ~10 GB class VRAM exceeds the local 4 GB Quadro-class budget; no weights downloaded.",
    nextStep: "Remote/self-hosted execution with explicit approval, or a reduced-quant profile verified against hardware.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "ow/trellis", displayName: "TRELLIS 3D (open weights)", kind: "open_weight",
    serves: ["forge-modeler"], domain: "local_tool", engines: ["blender-4.5"], maturity: "research",
    access: { auth: "local_install", costClass: "self_hosted" },
    license: { commercialUse: "conditional", detail: "MIT-adjacent research release — verify weights license before commercial use." },
    formats: ["glb", "obj"],
    vramMb: 8192,
    classification: "UNAVAILABLE",
    statusDetail: "VRAM estimate exceeds the 4 GB local budget; no weights downloaded.",
    nextStep: "Remote execution approval or documented low-VRAM path.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "bridge/blender-mcp", displayName: "Blender MCP bridge (external server)", kind: "mcp_server",
    serves: ["forge-modeler", "forge-material", "forge-character"], domain: "external_service", engines: ["blender-4.5"], maturity: "beta",
    access: { auth: "local_install", costClass: "free" },
    license: { commercialUse: "unknown" },
    classification: "EXPERIMENTAL",
    statusDetail: "Protocol-compatible with CodeForge's governed MCP client; requires user-authorized server config and a real connection before any tool executes.",
    nextStep: "User configures the MCP server; GovernedMcpClient handshake + bounded tool call.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "bridge/unreal-remote-control", displayName: "Unreal Remote Control API (4.27 plugin)", kind: "engine_bridge",
    serves: ["forge-gameplay", "forge-cinematic", "forge-verify", "forge-world"], domain: "local_tool", engines: ["ue-4.27"], maturity: "stable",
    access: { auth: "local_install", costClass: "free" },
    license: { commercialUse: "yes", detail: "Ships with UE 4.27 as an editor plugin." },
    classification: "EXPERIMENTAL",
    statusDetail: "Requires the Remote Control plugin enabled in the target project and a running editor; verified only when a real HTTP round-trip succeeds.",
    nextStep: "Enable plugin in project settings (user-approved), launch editor, probe /remote/object/call.",
    dataPolicy: { sendsPrivateContent: false },
  },
  {
    id: "svc/vision-qa", displayName: "Multimodal visual QA (routed model)", kind: "specialist_model",
    serves: ["forge-verify"], domain: "managed_free", engines: ["any"], maturity: "unknown",
    access: { auth: "unknown", costClass: "unknown" },
    license: { commercialUse: "unknown" },
    classification: "UNAVAILABLE",
    statusDetail: "Satisfied by any vision-capable route already eligible in the active domains; no dedicated vision integration is registered yet.",
    nextStep: "Qualify a vision-capable free/paid route for the forge-verify role.",
  },
];

export function seedCandidate(id: string): ForgeAaaCandidate | undefined {
  return FORGE_AAA_SEED_CANDIDATES.find((c) => c.id === id);
}
