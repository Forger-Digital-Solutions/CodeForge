export interface GitStatus {
  branch: string;
  clean: boolean;
  modified: string[];
  untracked: string[];
}

export interface Checkpoint {
  id: string;
  ref: string;
  message: string;
  timestamp: string;
}

export class GitOperations {
  constructor(workingDir: string) {}
  async status(): Promise<GitStatus> {
    return { branch: "main", clean: true, modified: [], untracked: [] };
  }
  async createCheckpoint(message: string): Promise<Checkpoint> {
    return { id: crypto.randomUUID(), ref: "HEAD", message, timestamp: new Date().toISOString() };
  }
}

export function isDirty(status: GitStatus): boolean {
  return !status.clean;
}
