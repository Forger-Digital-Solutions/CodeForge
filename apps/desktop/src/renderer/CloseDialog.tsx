import React, { useState } from "react";
import { summarizeActiveWork } from "../close-lifecycle.js";

export interface DesktopRuntimeStatus {
  activeWork: boolean;
  activeWorkflows: number;
  activeAgentTurns: number;
  activeCommands: number;
  pendingApprovals: number;
  activeVerifications: number;
  hostedContinuations: number;
  backgroundTasks: number;
  recoverable: boolean;
  unrecoverableResources: string[];
}

export interface CloseRequest {
  status: DesktopRuntimeStatus;
  preference: "ask" | "tray" | "quit-safe";
}

interface CloseDialogProps {
  request: CloseRequest;
  onDecision: (decision: "cancel" | "tray" | "quit" | "quit-anyway", remember: boolean) => void;
}

export default function CloseDialog({ request, onDecision }: CloseDialogProps): React.ReactElement {
  const [remember, setRemember] = useState(false);
  const { status } = request;
  return (
    <div className="close-dialog-overlay" role="presentation">
      <section className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
        <div className="close-dialog-kicker">CodeForge</div>
        <h2 id="close-dialog-title">Close CodeForge?</h2>
        {status.recoverable ? (
          <>
            <p className="close-dialog-lead">CodeForge still has active work.</p>
            <p className="close-dialog-copy">{summarizeActiveWork(status)}</p>
            <p className="close-dialog-copy">Keep CodeForge running in the background or quit safely. Completed and recoverable work will remain saved.</p>
          </>
        ) : (
          <>
            <p className="close-dialog-lead">CodeForge can&apos;t safely preserve all active work.</p>
            <p className="close-dialog-copy">{status.unrecoverableResources.join(" · ")}</p>
            <p className="close-dialog-copy">Keep CodeForge running to let the work finish, or quit anyway and accept the interruption.</p>
          </>
        )}
        <label className="close-dialog-check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Don&apos;t ask again when work is recoverable</span>
        </label>
        <div className="close-dialog-actions">
          <button type="button" className="close-dialog-button quiet" onClick={() => onDecision("cancel", false)}>Cancel</button>
          <button type="button" className="close-dialog-button danger" onClick={() => onDecision(status.recoverable ? "quit" : "quit-anyway", remember)}>
            {status.recoverable ? "Quit CodeForge" : "Quit anyway"}
          </button>
          <button type="button" className="close-dialog-button primary" autoFocus onClick={() => onDecision("tray", remember)}>Keep running in tray</button>
        </div>
      </section>
    </div>
  );
}
