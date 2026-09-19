/**
 * CodeForge action-authority engine.
 *
 * The product model: workflow transitions are NOT permission boundaries —
 * trust-boundary crossings are. Routine reversible work inside the authorized
 * workspace flows; leaving the workspace, touching shared external state,
 * sensitive resources, destructive operations, privilege, or money escalates.
 *
 * Three concepts stay separate:
 * - PermissionMode: what may run without asking (auto_review | ask_more | full_autonomy)
 * - PlanMode: whether the strategy itself is reviewed first (auto | review_first)
 * - Runtime escalation: ASK only when an operation crosses the current scope
 */

export type RiskLevel = "safe" | "moderate" | "high" | "critical";
export type RiskTier = 0 | 1 | 2 | 3 | 4;
export type PermissionMode = "auto_review" | "ask_more" | "full_autonomy";
export type PlanMode = "auto" | "review_first";
export type PolicyDecision = "allow" | "auto_review" | "ask" | "deny";
export type ApprovalSource = "deterministic" | "auto_review" | "user";

/** Read-only subagent roles inherit a read cap regardless of the session mode. */
export type AgentActor = "agent" | "explorer" | "planner" | "coder" | "reviewer";
const READ_ONLY_ACTORS: ReadonlySet<AgentActor> = new Set(["explorer", "planner", "reviewer"]);

export interface ActionDescriptor {
  /** Tool or subsystem requesting execution: read_file, run_command, git.push, ... */
  tool: string;
  /** Coarse action family used by grants: read | write | exec | checkpoint | external */
  action: string;
  /** Human description of the concrete operation (never secrets). */
  reason: string;
  targetPath?: string;
  command?: string;
  /** Whether the filesystem target is inside the authorized workspace. */
  insideWorkspace: boolean;
  /** Upstream risk label (command classifier / tool table). */
  risk: RiskLevel;
  /** Command-classifier category, when the action came from a shell command. */
  category?: string;
  /** Who is acting; read-only subagent roles are capped regardless of mode. */
  actor?: AgentActor;
}

export interface ClassifiedAction extends ActionDescriptor {
  tier: RiskTier;
  tierReasons: string[];
}

export interface LeaseGrant {
  /** action: matches ActionDescriptor.action; command_prefix: startsWith on
   * normalized command; directory: normalized path containment. */
  kind: "action" | "command_prefix" | "directory";
  value: string;
  scope: "task";
  grantedBy: "user";
  createdAt: string;
}

export interface TaskPermissionLease {
  sessionId: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  planMode: PlanMode;
  grants: LeaseGrant[];
  createdAt: string;
}

export interface PolicyReceipt {
  receiptId: string;
  sessionId: string;
  tool: string;
  action: string;
  detail: string;
  tier: RiskTier;
  decision: PolicyDecision;
  permissionMode: PermissionMode;
  source: ApprovalSource;
  /** Matched grant pattern when a lease supplied the authority. */
  grantPattern?: string;
  at: string;
}

export interface PolicyResolution {
  decision: PolicyDecision;
  classified: ClassifiedAction;
  grantPattern?: string;
}

const EXEC_READ_ONLY = new Set(["read-only"]);
const VERIFICATION_COMMAND = /^(npm test|npm run (test|typecheck|lint|build)(:\S+)?\b|npx (tsc|vitest|jest)\b|tsc\b|vitest\b|vite build\b|webpack\b|esbuild\b|next build\b|yarn (test|typecheck|lint|build)\b|pnpm (test|typecheck|lint|build)\b)/i;
const INSTALL_COMMAND = /^(npm (install|i)\b|yarn add\b|pnpm (add|install)\b|pip install\b|bun add\b)/i;
const EXTERNAL_GIT = /\bgit\s+(push|publish)\b|\bgh\s+(pr|issue|release)\s+(create|edit|merge|close)\b/i;
const PUBLISH_DEPLOY = /\b(npm|yarn|pnpm|bun)\s+publish\b|\b(wrangler|vercel|netlify|firebase|flyctl?)\s+(deploy|publish)\b|\bdocker\s+push\b|\bkubectl\s+(apply|delete)\b/i;
const EXTERNAL_MESSAGE = /\bgh\s+pr\s+comment\b|\bslack\b.*\bsend\b/i;

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Deterministic tier assignment. The model never self-classifies — policy derives
 * the tier from the tool table, command category, and workspace containment.
 */
export function classifyAction(desc: ActionDescriptor): ClassifiedAction {
  const reasons: string[] = [];
  const tier = (t: RiskTier, why: string): ClassifiedAction => {
    reasons.push(why);
    return { ...desc, tier: t, tierReasons: reasons };
  };

  if (desc.risk === "critical") {
    return tier(4, `critical classification (${desc.category ?? desc.tool})`);
  }

  if (desc.action === "read") {
    if (desc.insideWorkspace) return tier(0, "read inside workspace");
    return tier(2, "read outside workspace");
  }
  if (desc.action === "checkpoint") {
    return tier(0, "checkpoint is CodeForge-internal state");
  }
  if (desc.action === "write") {
    if (desc.insideWorkspace) return tier(1, "reversible workspace edit");
    return tier(3, "write outside the authorized workspace");
  }
  if (desc.action === "exec" && desc.command !== undefined) {
    const cmd = normalizeCommand(desc.command);
    if (desc.category && EXEC_READ_ONLY.has(desc.category)) {
      return tier(0, "read-only command");
    }
    if (EXTERNAL_GIT.test(cmd) || PUBLISH_DEPLOY.test(cmd) || EXTERNAL_MESSAGE.test(cmd)) {
      return tier(3, "externally visible side effect");
    }
    if (VERIFICATION_COMMAND.test(cmd)) {
      return tier(1, "project verification/build command");
    }
    if (INSTALL_COMMAND.test(cmd)) {
      return tier(2, "dependency install — network fetch and lockfile change");
    }
    if (desc.category === "network-sensitive") {
      return tier(3, "network-bound command");
    }
    if (desc.risk === "high") {
      return tier(3, `high-risk command (${desc.category ?? "unclassified"})`);
    }
    if (!desc.insideWorkspace) {
      return tier(3, "command targets outside the authorized workspace");
    }
    return tier(2, `project-modifying command (${desc.category ?? "unclassified"})`);
  }
  if (desc.action === "external") {
    return tier(3, "externally visible side effect");
  }

  if (desc.risk === "high") return tier(3, "high-risk action");
  if (desc.insideWorkspace) return tier(2, "unclassified workspace-scoped action");
  return tier(3, "unclassified action outside workspace");
}

function grantCovers(grant: LeaseGrant, action: ClassifiedAction): boolean {
  // Pattern grants never cover Tier 3/4: shared-external and sensitive/destructive
  // actions are re-confirmed per invocation by design.
  if (action.tier > 2) return false;
  switch (grant.kind) {
    case "action":
      return action.action === grant.value;
    case "command_prefix": {
      if (!action.command) return false;
      const cmd = normalizeCommand(action.command).toLowerCase();
      return cmd.startsWith(normalizeCommand(grant.value).toLowerCase());
    }
    case "directory": {
      if (!action.targetPath) return false;
      const target = normalizePath(action.targetPath);
      const dir = normalizePath(grant.value);
      return target === dir || target.startsWith(`${dir}/`);
    }
  }
}

export class TaskAuthority {
  private readonly lease: TaskPermissionLease;
  private readonly receipts: PolicyReceipt[] = [];
  private readonly onReceipt?: (receipt: PolicyReceipt) => void;

  constructor(lease: TaskPermissionLease, onReceipt?: (receipt: PolicyReceipt) => void) {
    this.lease = lease;
    this.onReceipt = onReceipt;
  }

  /** Live mode update — the composer can retune authority mid-task without
   * invalidating already-minted grants. */
  setModes(modes: { permissionMode?: PermissionMode; planMode?: PlanMode }): void {
    if (modes.permissionMode) this.lease.permissionMode = modes.permissionMode;
    if (modes.planMode) this.lease.planMode = modes.planMode;
  }

  getLease(): TaskPermissionLease {
    return this.lease;
  }

  getReceipts(): readonly PolicyReceipt[] {
    return this.receipts;
  }

  get permissionMode(): PermissionMode {
    return this.lease.permissionMode;
  }

  get planMode(): PlanMode {
    return this.lease.planMode;
  }

  private emit(action: ClassifiedAction, decision: PolicyDecision, source: ApprovalSource, grantPattern?: string): PolicyResolution {
    const receipt: PolicyReceipt = {
      receiptId: crypto.randomUUID(),
      sessionId: this.lease.sessionId,
      tool: action.tool,
      action: action.action,
      detail: action.reason,
      tier: action.tier,
      decision,
      permissionMode: this.lease.permissionMode,
      source,
      ...(grantPattern ? { grantPattern } : {}),
      at: new Date().toISOString(),
    };
    this.receipts.push(receipt);
    try {
      this.onReceipt?.(receipt);
    } catch {
      // A receipt sink failure must never change the policy outcome.
    }
    return { decision, classified: action, ...(grantPattern ? { grantPattern } : {}) };
  }

  /**
   * Resolve a requested action against the lease. Order matters:
   * role caps and grants are evaluated before mode, and Tier 3/4 always ask.
   */
  resolve(desc: ActionDescriptor): PolicyResolution {
    const action = classifyAction(desc);

    // Read-only subagent roles: mutations are denied outright — a subagent must
    // not escalate merely because the parent can.
    if (action.actor && READ_ONLY_ACTORS.has(action.actor) && (action.action === "write" || (action.action === "exec" && action.tier > 0))) {
      return this.emit(action, "deny", "deterministic");
    }

    const grant = this.lease.grants.find((g) => grantCovers(g, action));
    if (grant) {
      return this.emit(action, "allow", "user", `${grant.kind}:${grant.value}`);
    }

    switch (action.tier) {
      case 0:
        return this.emit(action, "allow", "deterministic");
      case 1:
        return this.lease.permissionMode === "ask_more"
          ? this.emit(action, "ask", "deterministic")
          : this.emit(action, "allow", "auto_review");
      case 2:
        return this.lease.permissionMode === "full_autonomy"
          ? this.emit(action, "allow", "auto_review")
          : this.emit(action, "ask", "deterministic");
      default:
        // Tier 3 (external/shared side effects) and Tier 4 (sensitive/destructive/
        // financial) always escalate — full autonomy never means crossing these.
        return this.emit(action, "ask", "deterministic");
    }
  }

  /**
   * Derive the narrowest grant pattern a user "Allow … for task" decision should
   * mint. Tier 3/4 never mint grants — the UI must not offer persistence there.
   */
  grantPatternFor(desc: ActionDescriptor): LeaseGrant | undefined {
    const action = classifyAction(desc);
    if (action.tier > 2) return undefined;
    if (action.action === "exec" && action.command) {
      const cmd = normalizeCommand(action.command);
      const install = INSTALL_COMMAND.exec(cmd);
      if (install) {
        // Grant the install family, not the literal command line — `npm install a`
        // and `npm install b` are the same authorized pattern.
        const family = cmd.startsWith("npm") ? "npm install" : cmd.split(/\s+/).slice(0, 2).join(" ");
        return { kind: "command_prefix", value: family, scope: "task", grantedBy: "user", createdAt: new Date().toISOString() };
      }
      return { kind: "command_prefix", value: cmd, scope: "task", grantedBy: "user", createdAt: new Date().toISOString() };
    }
    if (action.action === "write" && !action.insideWorkspace && action.targetPath) {
      // Out-of-workspace writes grant the specific directory, not "write anywhere".
      const dir = normalizePath(action.targetPath).split("/").slice(0, -1).join("/");
      return { kind: "directory", value: dir, scope: "task", grantedBy: "user", createdAt: new Date().toISOString() };
    }
    return { kind: "action", value: action.action, scope: "task", grantedBy: "user", createdAt: new Date().toISOString() };
  }

  addGrant(grant: LeaseGrant): void {
    const exists = this.lease.grants.some(
      (g) => g.kind === grant.kind && g.value.toLowerCase() === grant.value.toLowerCase(),
    );
    if (!exists) this.lease.grants.push(grant);
  }
}

export function createTaskAuthority(
  lease: TaskPermissionLease,
  onReceipt?: (receipt: PolicyReceipt) => void,
): TaskAuthority {
  return new TaskAuthority(lease, onReceipt);
}

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto_review";
export const DEFAULT_PLAN_MODE: PlanMode = "auto";

/**
 * Session records predate the mode model and may carry the legacy
 * allow|ask|deny policy vocabulary. Map it onto the nearest mode instead of
 * failing closed — a stale value must never silently widen authority.
 */
export function normalizePermissionMode(raw: string | undefined | null): PermissionMode {
  switch (raw) {
    case "auto_review":
    case "ask_more":
    case "full_autonomy":
      return raw;
    case "allow":
      return "full_autonomy";
    case "ask":
    case "deny":
      return "ask_more";
    default:
      return DEFAULT_PERMISSION_MODE;
  }
}

export function normalizePlanMode(raw: string | undefined | null): PlanMode {
  return raw === "review_first" ? "review_first" : DEFAULT_PLAN_MODE;
}

export function createLease(input: {
  sessionId: string;
  workspaceRoot: string;
  permissionMode?: string | null;
  planMode?: string | null;
  grants?: LeaseGrant[];
}): TaskPermissionLease {
  return {
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    permissionMode: normalizePermissionMode(input.permissionMode),
    planMode: normalizePlanMode(input.planMode),
    grants: input.grants ?? [],
    createdAt: new Date().toISOString(),
  };
}
