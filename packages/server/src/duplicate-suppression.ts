import { fingerprint } from "@codeforge/forge-green";

/**
 * FG-1C duplicate / no-progress suppression.
 *
 * One supervisor instance per run. Duplicates are never detected by command text alone: the
 * identity is bound to the workspace state version, which advances whenever a mutating action
 * executes, a steer is consumed (CF-17 revision change), or the execution revision changes.
 * A legitimate rerun after state change therefore never matches a prior identity, while an
 * identical read against provably unchanged state is redundant.
 *
 * Escalation is bounded and never silently reports success: suppress once (the prior
 * authoritative result is replayed with provenance), then surface a no-progress blocker that
 * the runtime turns into a blocked terminal state for replanning.
 */

export interface DuplicateActionIdentity {
  tool: string;
  /** Stable canonical form of the parsed tool arguments (not raw model text). */
  canonicalArguments: unknown;
  /** Targeted workstream scope, so alpha never suppresses (or is suppressed by) beta. */
  workstreamScope?: string;
  policyVersion?: string;
}

export type DuplicateDecision =
  | { action: "execute" }
  | { action: "execute_retry_failed" }
  | { action: "suppress"; reason: string; priorOutput: string; priorExecutionId: string }
  | { action: "escalate"; reason: string };

export interface DuplicateSuppressionMetrics {
  duplicateActionsSuppressed: number;
  noProgressEscalations: number;
}

interface DuplicateRecord {
  stateVersion: number;
  success?: boolean;
  priorOutput?: string;
  priorExecutionId?: string;
  /** Suppressions already issued for the current state version. */
  suppressionsAtState: number;
  /** Executions observed at the current state version. */
  attemptsAtState: number;
}

/** Exported for FG-9's own regression proof (packages/server/test/fg9-unsafe-mutating.test.ts)
 * that mutating tools can never reach a "suppress" decision — never redeclared/duplicated
 * elsewhere. */
export const READ_ONLY_SUPPRESSIBLE = new Set([
  "read_file",
  "list_files",
  "search_files",
  "repo_search",
  "repo_symbol",
  "repo_references",
  "repo_dependencies",
  "repo_dependents",
  "repo_tests",
  "repo_context",
  "repo_file_summary",
  "repo_impact",
  "repo_index_status",
]);

export const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

export class DuplicateActionSupervisor {
  private stateVersion = 1;
  private readonly records = new Map<string, DuplicateRecord>();
  readonly metrics: DuplicateSuppressionMetrics = { duplicateActionsSuppressed: 0, noProgressEscalations: 0 };

  constructor(
    private readonly options: { maxTrackedIdentities?: number; workstreamScope?: string; policyVersion?: string } = {},
  ) {}

  /** A mutating action (write/edit/command) changed workspace-relevant state. */
  recordMutation(): void {
    this.stateVersion++;
  }

  /** A steer was consumed at a safe boundary — post-steer work is never duplicate work. */
  noteSteerConsumed(): void {
    this.stateVersion++;
  }

  identityKey(identity: DuplicateActionIdentity): string {
    return fingerprint({
      tool: identity.tool,
      canonicalArguments: identity.canonicalArguments,
      workstreamScope: identity.workstreamScope ?? this.options.workstreamScope ?? "",
      policyVersion: identity.policyVersion ?? this.options.policyVersion ?? "",
    });
  }

  isReadOnly(tool: string): boolean {
    return READ_ONLY_SUPPRESSIBLE.has(tool);
  }

  isMutating(tool: string): boolean {
    return MUTATING_TOOLS.has(tool);
  }

  /**
   * Decide what to do with a pending read-only action before executing it.
   * Mutating actions are always executed and only update the state version after completion.
   */
  classify(identity: DuplicateActionIdentity): DuplicateDecision {
    if (!READ_ONLY_SUPPRESSIBLE.has(identity.tool)) {
      return { action: "execute" };
    }
    const key = this.identityKey(identity);
    const record = this.records.get(key);
    if (!record || record.stateVersion !== this.stateVersion) {
      return { action: "execute" };
    }
    if (record.success === true) {
      if (record.suppressionsAtState >= 1) {
        this.metrics.noProgressEscalations++;
        return {
          action: "escalate",
          reason: `No-progress loop: read-only action "${identity.tool}" was executed and then suppressed once against unchanged workspace state and is being requested again.`,
        };
      }
      this.metrics.duplicateActionsSuppressed++;
      record.suppressionsAtState++;
      return {
        action: "suppress",
        reason: "Identical read-only action against unchanged workspace state; prior authoritative result replayed without re-execution.",
        priorOutput: record.priorOutput ?? "",
        priorExecutionId: record.priorExecutionId ?? "",
      };
    }
    // Prior result class at this state was a failure. Allow exactly one retry; a third
    // identical attempt against unchanged state is a no-progress loop.
    if (record.attemptsAtState >= 2) {
      this.metrics.noProgressEscalations++;
      return {
        action: "escalate",
        reason: `No-progress loop: failing action "${identity.tool}" repeated against unchanged workspace state without remediation.`,
      };
    }
    return { action: "execute_retry_failed" };
  }

  /** Record the outcome of an executed read-only action. */
  recordReadResult(identity: DuplicateActionIdentity, output: string, success: boolean, executionId: string): void {
    const key = this.identityKey(identity);
    const existing = this.records.get(key);
    const sameState = existing?.stateVersion === this.stateVersion;
    this.records.set(key, {
      stateVersion: this.stateVersion,
      success,
      priorOutput: output,
      priorExecutionId: executionId,
      suppressionsAtState: sameState && existing ? existing.suppressionsAtState : 0,
      attemptsAtState: sameState && existing ? existing.attemptsAtState + 1 : 1,
    });
    this.bounded();
  }

  /** Record a mutating action: it executed and advanced workspace-relevant state. */
  recordMutationExecution(identity: DuplicateActionIdentity, success: boolean): void {
    this.stateVersion++;
    const key = this.identityKey(identity);
    this.records.set(key, {
      stateVersion: this.stateVersion,
      success,
      suppressionsAtState: 0,
      attemptsAtState: 1,
    });
    this.bounded();
  }

  private bounded(): void {
    const max = Math.max(16, this.options.maxTrackedIdentities ?? 512);
    while (this.records.size > max) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) return;
      this.records.delete(oldest);
    }
  }
}

export function createDuplicateActionSupervisor(
  options?: { maxTrackedIdentities?: number; workstreamScope?: string; policyVersion?: string },
): DuplicateActionSupervisor {
  return new DuplicateActionSupervisor(options);
}
