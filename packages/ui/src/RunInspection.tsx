import React, { useMemo, useState } from "react";
import type { WorkspaceEvent } from "@codeforge/protocol";
import type { WorkItem } from "@codeforge/sessions";
import DiffViewer from "./DiffViewer.js";
import { projectRunInspection, selectInspectableRunId, type InspectionAgent } from "./run-inspection.js";

export interface RunInspectionProps {
  events: WorkspaceEvent[];
  workItems: WorkItem[];
  preferredRunId?: string | null;
  startFailure?: { code: string; message: string };
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function renderAgentTree(agents: InspectionAgent[]): React.ReactNode {
  const byParent = new Map<string | undefined, InspectionAgent[]>();
  for (const agent of agents) {
    const parent = agents.some((candidate) => candidate.id === agent.parentId) ? agent.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), agent]);
  }
  const renderNodes = (parentId: string | undefined): React.ReactNode => {
    const nodes = byParent.get(parentId) ?? [];
    if (nodes.length === 0) return null;
    return (
      <ul className="run-inspection-tree">
        {nodes.map((agent) => (
          <li key={agent.id}>
            <span className="run-inspection-status" data-status={agent.status}>{statusLabel(agent.status)}</span>
            <span className="run-inspection-agent-role">{agent.role}</span>
            <span className="run-inspection-agent-id">{agent.id}</span>
            {agent.task ? <div className="run-inspection-secondary">{agent.task}</div> : null}
            {agent.failure ? <div className="run-inspection-error">{agent.failure}</div> : null}
            {agent.result ? <div className="run-inspection-secondary">{agent.result}</div> : null}
            {renderNodes(agent.id)}
          </li>
        ))}
      </ul>
    );
  };
  return renderNodes(undefined);
}

function StartFailure({ failure }: { failure: { code: string; message: string } }) {
  return (
    <section className="run-inspection" aria-label="Agent start failure">
      <div className="run-inspection-heading">
        <span>Agent could not start</span>
        <span className="run-inspection-status" data-status="failed">failed to start</span>
      </div>
      <div className="run-inspection-error">{failure.code}: {failure.message}</div>
      <div className="run-inspection-secondary">No files changed · No tools executed · No verification ran</div>
    </section>
  );
}

export default function RunInspection({ events, workItems, preferredRunId, startFailure }: RunInspectionProps) {
  const runId = useMemo(() => selectInspectableRunId(events, workItems, preferredRunId), [events, workItems, preferredRunId]);
  const inspection = useMemo(() => runId ? projectRunInspection(events, workItems, runId) : undefined, [events, workItems, runId]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  if (!inspection) return startFailure ? <StartFailure failure={startFailure} /> : null;
  const selectedChange = inspection.changes.find((change) => change.path === selectedPath);
  const certified = inspection.completion?.outcome === "completed";
  const verificationRan = inspection.forgeVerify ? inspection.forgeVerify.evidence.length > 0 : inspection.verification.some((attempt) => !attempt.notConfigured);

  return (
    <section className="run-inspection" aria-label="Run details">
      <div className="run-inspection-heading" role="status" aria-live="polite">
        <span>Run details</span>
        <span className="run-inspection-status" data-status={inspection.status}>{statusLabel(inspection.status)}</span>
        {certified ? <span className="run-inspection-certified">Certified</span> : null}
      </div>

      <details open>
        <summary>Overview</summary>
        <dl className="run-inspection-grid">
          <dt>Mode</dt><dd>Agent</dd>
          <dt>Run</dt><dd className="run-inspection-code">{inspection.runId}</dd>
          <dt>Phase</dt><dd>{inspection.phase ? statusLabel(inspection.phase) : "Starting"}</dd>
          <dt>Started</dt><dd>{inspection.startedAt ?? "Unavailable"}</dd>
          <dt>Workspace</dt><dd>{inspection.workspace ? `${inspection.workspace.kind} · ${inspection.workspace.id}` : "Unavailable"}</dd>
          <dt>Model</dt><dd>{inspection.provider ? `${inspection.provider.providerId} / ${inspection.provider.modelId}` : "Unavailable"}</dd>
          <dt>Usage</dt><dd>{inspection.usage ? `${inspection.usage.totalTokens} tokens` : "Unavailable"}</dd>
          <dt>Cost</dt><dd>Unavailable</dd>
          <dt>Latency</dt><dd>Unavailable</dd>
          <dt>Availability</dt><dd>Unavailable</dd>
          <dt>Verification</dt><dd>{!verificationRan ? "Not run" : inspection.forgeVerify ? (inspection.forgeVerify.verificationComplete ? "Current evidence complete" : "Needs attention") : inspection.verification.at(-1)?.failed ? "Failed" : "Passed"}</dd>
          <dt>Completion</dt><dd>{certified ? "Certified" : inspection.completion ? statusLabel(inspection.completion.outcome) : "Not decided"}</dd>
        </dl>
      </details>

      <details open>
        <summary>Agents ({inspection.agents.length})</summary>
        {inspection.agents.length ? renderAgentTree(inspection.agents) : <div className="panel-empty">No child agents were spawned.</div>}
      </details>

      <details>
        <summary>Tool activity ({inspection.tools.length})</summary>
        {inspection.tools.length ? <ul className="run-inspection-list">
          {inspection.tools.map((tool) => <li key={tool.id}>
            <span className="run-inspection-status" data-status={tool.status}>{statusLabel(tool.status)}</span>
            <span>{tool.name}</span>
            {tool.agentId ? <span className="run-inspection-secondary"> · {tool.agentId}</span> : null}
            {tool.durationMs !== undefined ? <span className="run-inspection-secondary"> · {tool.durationMs}ms</span> : null}
            {tool.failure ? <div className="run-inspection-error">{tool.failure}</div> : null}
          </li>)}
        </ul> : <div className="panel-empty">No tools executed.</div>}
      </details>

      <details open>
        <summary>Changes ({inspection.changes.length})</summary>
        {inspection.changes.length ? <>
          <ul className="run-inspection-list">
            {inspection.changes.map((change) => <li key={change.id}>
              <button type="button" className="run-inspection-file" onClick={() => setSelectedPath(change.path)} aria-pressed={selectedPath === change.path}>
                {change.path}
              </button>
              <span className="run-inspection-secondary"> · {change.binary ? "binary modified" : `${change.changeType} · +${change.additions} −${change.deletions}`}</span>
              {change.binary && change.beforeSize !== undefined && change.afterSize !== undefined ? <span className="run-inspection-secondary"> · {change.beforeSize}B → {change.afterSize}B</span> : null}
              {change.truncated ? <span className="run-inspection-secondary"> · patch truncated</span> : null}
            </li>)}
          </ul>
          {selectedChange?.binary ? <div className="panel-empty">Binary content is not rendered.</div> : selectedChange?.diff ? <DiffViewer diff={selectedChange.diff} fileName={selectedChange.path} /> : selectedChange ? <div className="panel-empty">No text patch is available for this file.</div> : null}
        </> : <div className="panel-empty">No files changed.</div>}
      </details>

      <details open>
        <summary>Verification ({inspection.forgeVerify?.evidence.length ?? inspection.verification.length})</summary>
        {inspection.forgeVerify ? <div className="run-inspection-list">
          <div className="run-inspection-secondary">Plan {inspection.forgeVerify.planId} · policy {inspection.forgeVerify.policyVersion} · {inspection.forgeVerify.satisfiedCount}/{inspection.forgeVerify.requiredCount} required current</div>
          {inspection.forgeVerify.evidence.map((evidence) => <div key={evidence.evidenceId} className="run-inspection-verifier">
            <span className="run-inspection-status" data-status={evidence.status}>{statusLabel(evidence.status)}</span>
            <code>{evidence.verifierId}</code><span className="run-inspection-secondary"> · {evidence.durationMs}ms{evidence.outputTruncated ? " · output truncated" : ""}</span>
          </div>)}
          {inspection.forgeVerify.missingRequiredVerifiers.length ? <div className="run-inspection-error">Needs evidence: {inspection.forgeVerify.missingRequiredVerifiers.join(", ")}</div> : null}
        </div> : null}
        {inspection.verification.length ? <ol className="run-inspection-list">
          {inspection.verification.map((attempt) => <li key={attempt.attempt}>
            <strong>Attempt {attempt.attempt}</strong>{attempt.notConfigured ? " · Not run" : ` · ${attempt.failed ? "Failed" : "Passed"} · ${attempt.passed} passed / ${attempt.failed} failed`}
            {attempt.verifiers.map((verifier) => <div key={verifier.id} className="run-inspection-verifier">
              <span className="run-inspection-status" data-status={verifier.status}>{statusLabel(verifier.status)}</span>
              <code>{verifier.command}</code>
              <span className="run-inspection-secondary"> · exit {verifier.exitCode} · {verifier.durationMs}ms</span>
              {verifier.failureSummary ? <div className="run-inspection-error">{verifier.failureSummary}</div> : null}
            </div>)}
          </li>)}
        </ol> : <div className="panel-empty">Verification not run.</div>}
        {inspection.repairs.length ? <div className="run-inspection-repairs">
          <strong>Repair attempts</strong>
          <ol className="run-inspection-list">{inspection.repairs.map((repair) => <li key={repair.attempt}>After attempt {repair.attempt}: {repair.summary}</li>)}</ol>
        </div> : null}
      </details>

      <details>
        <summary>Review</summary>
        {inspection.review ? <div>
          <div>{inspection.review.approved ? "Approved" : "Needs attention"}</div>
          {inspection.review.findings.length ? <ul className="run-inspection-list">{inspection.review.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.severity} · {finding.path} · {finding.message}</li>)}</ul> : <div className="run-inspection-secondary">No structured findings.</div>}
        </div> : <div className="panel-empty">Review not run.</div>}
      </details>

      <details>
        <summary>Approvals ({inspection.approvals.length})</summary>
        {inspection.approvals.length ? <ul className="run-inspection-list">{inspection.approvals.map((approval) => <li key={approval.id}><span className="run-inspection-status" data-status={approval.status}>{statusLabel(approval.status)}</span> {approval.action} · {approval.description}</li>)}</ul> : <div className="panel-empty">No approval required.</div>}
      </details>

      <details open>
        <summary>Completion evidence</summary>
        {inspection.completion ? <div>
          <div>{certified ? "Certified by the completion gate." : `Not certified · ${statusLabel(inspection.completion.outcome)}`}</div>
          <div className="run-inspection-secondary">{inspection.completion.rationale}</div>
          {inspection.completion.blockers.length ? <ul className="run-inspection-list">{inspection.completion.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}>{blocker.severity} · {blocker.code} · {blocker.message}</li>)}</ul> : null}
        </div> : <div className="panel-empty">Completion gate has not decided.</div>}
      </details>
    </section>
  );
}
