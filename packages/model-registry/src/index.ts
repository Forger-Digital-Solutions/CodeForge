export type RefreshResult = { added: number; updated: number };

export class FreeModelRegistry {
  register(model: unknown): void {}
  all(): unknown[] { return []; }
}

export function createRegistry(): FreeModelRegistry {
  return new FreeModelRegistry();
}
