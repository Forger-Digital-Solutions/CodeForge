export interface CodingProgressSnapshot {
  version: 1;
  actionsWithoutMutation: number;
  mutations: number;
  interventions: Array<{ reason: string; actionBudget: number; actions: number; mutations: number }>;
}

export class CodingProgress {
  private state: CodingProgressSnapshot;

  constructor(snapshot?: unknown) {
    if (snapshot === undefined) {
      this.state = { version: 1, actionsWithoutMutation: 0, mutations: 0, interventions: [] };
      return;
    }
    const value = snapshot as Partial<CodingProgressSnapshot> | null;
    const counter = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!value || value.version !== 1 || !counter(value.actionsWithoutMutation) || !counter(value.mutations)
      || !Array.isArray(value.interventions) || value.interventions.length > 2
      || value.interventions.some(entry => !entry || typeof entry.reason !== "string" || entry.reason.length > 200
        || entry.actionBudget !== 6 || !counter(entry.actions) || !counter(entry.mutations))) {
      throw new Error("[AGENT_NO_PROGRESS_DETECTED] invalid durable coding progress budget");
    }
    this.state = structuredClone(value as CodingProgressSnapshot);
  }

  snapshot(): CodingProgressSnapshot { return structuredClone(this.state); }

  chargeAction(): void {
    this.state.actionsWithoutMutation++;
    const latest = this.state.interventions.at(-1);
    if (latest && latest.mutations === this.state.mutations && latest.actions < latest.actionBudget) latest.actions++;
  }

  recordMutation(): void {
    this.state.mutations++;
    this.state.actionsWithoutMutation = 0;
  }

  intervene(): string | undefined {
    if (this.state.actionsWithoutMutation < 12) return;
    const latest = this.state.interventions.at(-1);
    if (latest && latest.mutations === this.state.mutations && latest.actions >= latest.actionBudget) {
      throw new Error("[AGENT_NO_PROGRESS_DETECTED] coding investigation exhausted its six-action recovery budget without a source mutation");
    }
    if (latest && latest.mutations === this.state.mutations) return;
    if (this.state.interventions.length >= 2) {
      throw new Error("[AGENT_NO_PROGRESS_DETECTED] coding investigation exhausted its two interventions");
    }
    this.state.interventions.push({ reason: "Twelve tool actions without an applied source mutation", actionBudget: 6, actions: 0, mutations: this.state.mutations });
    return "Coding progress intervention: twelve tool actions have produced no applied source mutation. Summarize the located implementation, remaining question, and next executable action concisely. Preserve the original request and approved scope. Use the next six tool actions to make the required edit, check a concrete hypothesis, or report a blocker. Do not repeat exhausted searches or reads. Verification and independent review still follow; do not claim completion without implementing the task.";
  }
}
