export interface ContextArtifact {
  path: string;
  content: string;
  relevance: number;
}

export class ContextAssembler {
  assemble(task: unknown): ContextArtifact[] {
    return [];
  }
}
