/**
 * Single source of truth for favorited model ids — shared by `ModelSelector` (the star toggle in
 * the dropdown) and the empty-state's favorites row, so the two can never disagree about which
 * models are favorited or where that state lives.
 */
export const MODEL_FAVORITES_KEY = "codeforge:model-favorites";

export function loadModelFavorites(): Set<string> {
  try {
    const stored = window.localStorage.getItem(MODEL_FAVORITES_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveModelFavorites(favorites: Set<string>): void {
  try {
    window.localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify([...favorites]));
  } catch {
    // ignore — favorites are a convenience, not durable state
  }
}
