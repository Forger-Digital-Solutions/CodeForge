import React, { useState } from "react";
import type { WorkspaceState } from "./workspace-sse.js";

interface WorkflowProgressProps {
  state: WorkspaceState;
  onCancel: () => void;
  onApprove: (decision: "allow_once" | "allow_session" | "deny") => void;
  onPublishDelivery?: (deliveryId: string) => void;
  onRetryPublication?: (deliveryId: string) => void;
  onAuthorizeRepository?: (deliveryId: string) => void;
  expanded?: boolean;
}

export const PHASES: Array<{ key: string; label: string }> = [
  { key: "received", label: "Received" },
  { key: "reconnaissance", label: "Reconnaissance" },
  { key: "planning", label: "Planning" },
  { key: "user_input_required", label: "Approval" },
  { key: "implementing", label: "Implementing" },
  { key: "testing", label: "Verifying" },
  { key: "diagnosing", label: "Diagnosing" },
  { key: "repairing", label: "Repairing" },
  { key: "reviewing", label: "Reviewing" },
  { key: "validating", label: "Summarizing" },
  { key: "complete", label: "Completed" },
];

interface ParallelWorkstreamState { workstreamId: string; status: string }
interface ParallelDispatchState { workstreamId: string; state: string }

interface MissionMilestoneState { id: string; title: string; status: string; dependencies: string[] }
interface MissionPlanVersionState {
  version: number;
  parentVersion?: number;
  reason?: { type: string };
  diff?: { preservedMilestones: string[]; invalidatedMilestones: string[]; addedMilestones: string[] };
}
interface MissionDetailState {
  milestones?: MissionMilestoneState[];
  planVersions?: MissionPlanVersionState[];
  usage?: { waves?: number; replans?: number; workstreams?: number };
  steering?: Array<{ type: string; message?: string }>;
  pauseRequested?: boolean;
}
interface DeliveryDetailState {
  deliveryBranch?: string;
  commits?: Array<{ title: string; sha?: string }>;
  reviewPackage?: { title?: string; verdict?: string; summary?: string };
}
/** The Cloud-authoritative publication view mirrored into the desktop work item. */
interface CloudPublicationDetailState {
  id?: string;
  state?: string;
  targetBranch?: string;
  pushRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  errorCode?: string;
  canRetry?: boolean;
  receipt?: { repositoryFullName?: string; pullRequestNumber?: number; pullRequestUrl?: string; publishedCommit?: string; publicationRef?: string };
}

/**
 * Every Cloud publication state the UI can render. Success is shown only for `completed`: a local
 * Git result never drives this label.
 */
export const CLOUD_PUBLICATION_LABELS: Record<string, string> = {
  identity_required: "Sign in to CodeForge Cloud to publish",
  authorization_required: "GitHub App repository authorization required",
  authorization_pending: "Waiting for GitHub App authorization",
  preparing: "Preparing certified artifact",
  awaiting_artifact: "Uploading certified artifact",
  artifact_uploaded: "Artifact uploaded",
  validating: "Cloud validating artifact",
  validated: "Artifact validated",
  waiting_for_lease: "Waiting for a Cloud executor",
  authorizing: "Cloud authorizing repository access",
  checking_target: "Checking remote target branch",
  pushing: "Cloud publishing branch",
  pushed: "Branch published",
  creating_pr: "Cloud creating pull request",
  pr_created: "Pull request created",
  completed: "Published",
  failed_retryable: "Publication failed — retry available",
  failed_permanent: "Publication failed",
  authorization_revoked: "Repository authorization revoked",
  target_diverged: "Target branch moved since certification",
};

const CLOUD_PUBLICATION_IN_FLIGHT = [
  "preparing", "awaiting_artifact", "artifact_uploaded", "validating", "validated",
  "waiting_for_lease", "authorizing", "checking_target", "pushing", "pushed", "creating_pr", "pr_created",
];

const MISSION_ICONS: Record<string, string> = {
  completed: "\u2713",
  executing: "\u25cf",
  verifying: "\u25cf",
  invalidated: "\u2717",
  blocked: "\u2717",
  cancelled: "\u2717",
};

const DISPATCH_LABELS: Record<string, string | undefined> = {
  dispatched: "running",
  active: "running",
  cancelled: "cancelled",
  revalidation_required: "needs revalidation",
};

export function phaseIndex(phase: string): number {
  const direct = PHASES.findIndex((p) => p.key === phase);
  if (direct !== -1) return direct;
  const map: Record<string, string> = {
    understanding: "reconnaissance",
    inspecting: "reconnaissance",
    building_context: "reconnaissance",
    exploring: "reconnaissance",
    planning: "planning",
    executing: "implementing",
    awaiting_approval: "user_input_required",
    verifying: "testing",
    revising: "repairing",
    reviewing: "reviewing",
    integration_ready: "validating",
    integrating: "validating",
    summarizing: "validating",
    completed: "complete",
    blocked: "complete",
    failed_safely: "complete",
    cancelled: "complete",
    failed: "complete",
  };
  const mapped = map[phase];
  if (mapped) return PHASES.findIndex((p) => p.key === mapped);
  return -1;
}

export default function WorkflowProgress({ state, onCancel, onApprove, onPublishDelivery, onRetryPublication, onAuthorizeRepository, expanded: controlledExpanded }: WorkflowProgressProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const { activePhase, isRunning, pendingApproval, activeTaskId, workflowError, lastWorkflowResult } = state;
  const parallelRun = [...state.workItems].reverse().find((item) => item.kind === "parallel_run");
  const missionRun = [...state.workItems].reverse().find((item) => item.kind === "mission");
  const deliveryRun = [...state.workItems].reverse().find((item) => item.kind === "change_delivery");
  const publicationRun = [...state.workItems].reverse().find((item) => item.kind === "cloud_publication");

  const hasActiveWorkflow = Boolean(
    activeTaskId || isRunning || pendingApproval?.tool === "workflow" || workflowError || lastWorkflowResult,
  );

  if (!hasActiveWorkflow && !parallelRun && !missionRun && !deliveryRun) return null;

  if (deliveryRun) {
    const delivery = deliveryRun;
    const detail = delivery.deliveryJson ? JSON.parse(delivery.deliveryJson) as DeliveryDetailState : {};
    const commits = detail.commits ?? [];
    const review = detail.reviewPackage;
    const publication = publicationRun;
    const publicationDetail = publication?.publicationJson ? JSON.parse(publication.publicationJson) as CloudPublicationDetailState : undefined;
    const publicationLabel = publication ? CLOUD_PUBLICATION_LABELS[publication.status] ?? publication.status : undefined;
    return (
      <div className="workflow-stages" role="status" aria-live="polite">
        <button type="button" className="workflow-stages-header" onClick={() => setInternalExpanded(!internalExpanded)} aria-expanded={expanded}>
          <span className="activity-chevron" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
          <span>Delivery · {delivery.status}{delivery.status === "ready" ? " · PR-ready" : ""}</span>
        </button>
        {expanded && <div className="workflow-stages-list">
          <div className="workflow-stage"><span>Certified source · {delivery.sourceRevision.slice(0, 12)}</span></div>
          <div className="workflow-stage"><span>Packaging · {commits.length} commit{commits.length === 1 ? "" : "s"}</span></div>
          {commits.map((commit, index) => <div key={`${commit.sha ?? commit.title}-${index}`} className="workflow-stage"><span>{commit.title}{commit.sha ? ` · ${commit.sha.slice(0, 12)}` : ""}</span></div>)}
          <div className="workflow-stage"><span>Review · {review?.verdict ?? (delivery.status === "reviewing" ? "running" : "pending")}</span></div>
          {review?.summary ? <div className="workflow-stage"><span>{review.summary}</span></div> : null}
          {publication ? <>
            <div className="workflow-stage"><span>Cloud publication · {publicationLabel}</span></div>
            {publication.status === "identity_required" ? <div className="workflow-stage"><span>External action required · Sign in to CodeForge Cloud</span></div> : null}
            {publication.status === "authorization_required" ? <>
              <div className="workflow-stage"><span>External action required · Authorize this repository for the CodeForge GitHub App</span></div>
              <button type="button" className="btn-sm" onClick={() => onAuthorizeRepository?.(delivery.id)}>Authorize repository</button>
            </> : null}
            {publication.status === "authorization_revoked" ? <>
              <div className="workflow-stage"><span>Publication stopped · the GitHub App authorization for this repository was removed</span></div>
              <button type="button" className="btn-sm" onClick={() => onAuthorizeRepository?.(delivery.id)}>Re-authorize repository</button>
            </> : null}
            {publication.status === "target_diverged" ? <div className="workflow-stage"><span>Publication stopped · the target branch advanced after certification, so the certified result was not published</span></div> : null}
            {CLOUD_PUBLICATION_IN_FLIGHT.includes(publication.status) ? <div className="workflow-stage"><span>Cloud is publishing · this result is authoritative only when Cloud reports completion</span></div> : null}
            {publicationDetail?.receipt?.repositoryFullName ? <div className="workflow-stage"><span>Target · {publicationDetail.receipt.repositoryFullName} / {publicationDetail.targetBranch}</span></div> : null}
            {publicationDetail?.pushRef ? <div className="workflow-stage"><span>Publication ref · {publicationDetail.pushRef}</span></div> : null}
            {publication.status === "completed" && publicationDetail?.pullRequestNumber ? <div className="workflow-stage"><span>Pull request · #{publicationDetail.pullRequestNumber} · {publicationDetail.pullRequestUrl}</span></div> : null}
            {publicationDetail?.receipt?.publishedCommit ? <div className="workflow-stage"><span>Published commit · {publicationDetail.receipt.publishedCommit.slice(0, 12)}</span></div> : null}
            {publication.error ? <div className="workflow-stage"><span>{publication.error}</span></div> : null}
            {(publication.status === "failed_retryable" || publicationDetail?.canRetry) ? <button type="button" className="btn-sm" onClick={() => onRetryPublication?.(delivery.id)}>Retry publication</button> : null}
          </> : null}
          {!publication && delivery.status === "ready" ? <button type="button" className="btn-sm" onClick={() => onPublishDelivery?.(delivery.id)}>Publish to GitHub via CodeForge Cloud</button> : null}
          {delivery.error ? <div className="workflow-stage"><span>{delivery.error}</span></div> : null}
        </div>}
      </div>
    );
  }

  if (missionRun) {
    const mission = missionRun;
    const detail = mission.missionJson ? JSON.parse(mission.missionJson) as MissionDetailState : {};
    const milestones = detail.milestones ?? [];
    const completed = milestones.filter((milestone) => milestone.status === "completed").length;
    const planVersions = detail.planVersions ?? [];
    const latestReplan = [...planVersions].reverse().find((version) => version.reason);
    const replans = detail.usage?.replans ?? 0;
    const steeringState = mission.status === "paused" ? "paused"
      : detail.pauseRequested ? "pausing"
      : mission.status === "replanning" ? "replanning"
      : mission.status === "evaluating" ? "awaiting steering"
      : mission.status;
    return (
      <div className="workflow-stages" role="status" aria-live="polite">
        <button type="button" className="workflow-stages-header" onClick={() => setInternalExpanded(!internalExpanded)} aria-expanded={expanded}>
          <span className="activity-chevron" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>&#8250;</span>
          <span>Mission &middot; {completed}/{milestones.length} milestones &middot; {steeringState}</span>
        </button>
        {expanded && <div className="workflow-stages-list">
          <div className="workflow-stage"><span>{mission.goal}</span></div>
          {milestones.map((milestone) => (
            <div key={milestone.id} className="workflow-stage">
              <span className="workflow-stage-icon">{MISSION_ICONS[milestone.status] ?? "\u25cb"}</span>
              <span>{milestone.title} &middot; {milestone.status}{milestone.dependencies.length ? ` \u00b7 waiting on ${milestone.dependencies.join(", ")}` : ""}</span>
            </div>
          ))}
          <div className="workflow-stage"><span>Wave {mission.currentWave ?? 0} &middot; Plan v{mission.currentPlanVersion ?? 1} &middot; {replans} replan{replans === 1 ? "" : "s"}</span></div>
          {latestReplan && <div className="workflow-stage">
            <span>Plan v{latestReplan.parentVersion ?? latestReplan.version - 1} &rarr; v{latestReplan.version} &middot; {latestReplan.reason?.type}
              {latestReplan.diff ? ` \u00b7 preserved ${latestReplan.diff.preservedMilestones.join(", ") || "none"} \u00b7 replanned ${[...latestReplan.diff.invalidatedMilestones, ...latestReplan.diff.addedMilestones].join(", ") || "none"}` : ""}</span>
          </div>}
          {detail.steering?.length ? <div className="workflow-stage"><span>Steering &middot; {detail.steering[detail.steering.length - 1]!.type}{detail.steering[detail.steering.length - 1]!.message ? `: ${detail.steering[detail.steering.length - 1]!.message}` : ""}</span></div> : null}
          {mission.error ? <div className="workflow-stage"><span>{mission.error}</span></div> : null}
        </div>}
      </div>
    );
  }

  if (parallelRun) {
    // The durable record carries both terminal results and in-flight dispatches; older rows
    // stored only the result array.
    const parallelState = parallelRun.workstreamsJson
      ? JSON.parse(parallelRun.workstreamsJson) as ParallelWorkstreamState[] | { results?: ParallelWorkstreamState[]; dispatches?: ParallelDispatchState[] }
      : [];
    const workstreams = Array.isArray(parallelState) ? parallelState : parallelState.results ?? [];
    const dispatches = Array.isArray(parallelState) ? [] : parallelState.dispatches ?? [];
    const completed = workstreams.filter((workstream) => workstream.status === "completed").length;
    const plan = parallelRun.planJson ? JSON.parse(parallelRun.planJson) as { workstreams?: Array<{ id: string; title: string; dependencies: string[] }> } : undefined;
    const total = plan?.workstreams?.length ?? workstreams.length;
    const statusFor = (id: string): string =>
      workstreams.find((item) => item.workstreamId === id)?.status
      ?? DISPATCH_LABELS[dispatches.find((item) => item.workstreamId === id)?.state ?? ""]
      ?? "waiting";
    return (
      <div className="workflow-stages" role="status" aria-live="polite">
        <button type="button" className="workflow-stages-header" onClick={() => setInternalExpanded(!internalExpanded)} aria-expanded={expanded}>
          <span className="activity-chevron" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
          <span>Parallel engineering · {completed}/{total} workstreams · {parallelRun.status}</span>
        </button>
        {expanded && <div className="workflow-stages-list">
          {(plan?.workstreams ?? []).map((workstream) => {
            const status = statusFor(workstream.id);
            return <div key={workstream.id} className="workflow-stage"><span className="workflow-stage-icon">{status === "completed" ? "✓" : status === "running" || status === "reviewing" ? "●" : "○"}</span><span>{workstream.title} · {status}{workstream.dependencies.length ? ` · waiting on ${workstream.dependencies.join(", ")}` : ""}</span></div>;
          })}
          <div className="workflow-stage"><span className="workflow-stage-icon">{parallelRun.status === "synthesizing" ? "●" : parallelRun.synthesisJson ? "✓" : "○"}</span><span>Synthesis · {parallelRun.status}{parallelRun.error ? ` · ${parallelRun.error}` : ""}</span></div>
        </div>}
      </div>
    );
  }

  const idx = phaseIndex(activePhase);
  const completedCount = idx >= 0 ? Math.min(idx + 1, PHASES.length) : 0;
  const isTerminal = activePhase === "complete" || activePhase === "completed" || activePhase === "blocked" || activePhase === "failed_safely" || activePhase === "cancelled" || activePhase === "failed";
  const startFailureEvent = [...state.events].reverse().find((event) => event.type === "execution.start_failed");
  const startFailure = startFailureEvent?.type === "execution.start_failed" ? startFailureEvent.payload : undefined;

  const showApproval = pendingApproval && pendingApproval.tool === "workflow" && pendingApproval.action === "execute_plan";

  const statusText = startFailure
    ? "Agent could not start"
    : isTerminal
    ? activePhase === "complete" || activePhase === "completed"
      ? `Completed · ${completedCount}/${PHASES.length} stages`
      : activePhase === "blocked"
      ? "Blocked · not verified"
      : activePhase === "failed_safely"
        ? "Failed safely"
        : activePhase === "cancelled"
          ? "Cancelled"
          : "Failed"
    : isRunning
      ? `Working · ${activePhase}`
      : `${completedCount}/${PHASES.length} stages`;

  return (
    <div className="workflow-stages" role="status" aria-live="polite">
      <button
        type="button"
        className="workflow-stages-header"
        onClick={() => setInternalExpanded(!internalExpanded)}
        aria-expanded={expanded}
      >
        <span className="activity-chevron" style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
        <span>{statusText}</span>
        {isRunning && !isTerminal && (
          <span style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className="btn-sm danger"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              Cancel
            </button>
          </span>
        )}
      </button>

      {expanded && (
        <div className="workflow-stages-list">
          {startFailure ? <>
            <div className="workflow-stage"><span>Code · {startFailure.code}</span></div>
            <div className="workflow-stage"><span>{startFailure.message}</span></div>
            <div className="workflow-stage"><span>No files changed · No tools executed · No verification ran</span></div>
          </> : PHASES.map((p, i) => {
            const isPast = idx >= 0 ? i < idx : false;
            const isCurrent = i === idx;
            const className = isPast ? "past" : isCurrent ? "current" : "future";
            return (
              <div key={p.key} className={`workflow-stage ${className}`}>
                <span className="workflow-stage-icon">
                  {isPast ? "✓" : isCurrent && isRunning ? "●" : "○"}
                </span>
                <span>{p.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/*
        The decision itself belongs to exactly one control — ApprovalBar. This panel reports that
        the workflow is parked and why, but offers no second set of buttons: rendering the same
        approval as several independent cards made one decision look like several, and left the
        user unsure which one the agent was actually waiting on.
      */}
      {showApproval && (
        <div className="workflow-awaiting" style={{ marginTop: 8 }}>
          <span className="workflow-awaiting-dot" aria-hidden="true">●</span>
          <span>
            Waiting for your decision on <code>{pendingApproval.action}</code> — see the approval
            prompt below.
          </span>
        </div>
      )}
    </div>
  );
}
