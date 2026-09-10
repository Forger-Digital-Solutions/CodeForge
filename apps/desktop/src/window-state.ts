export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowDisplay {
  workArea: WindowBounds;
}

export interface PersistedWindowState {
  bounds: WindowBounds;
  isMaximized: boolean;
}

export interface RestoredWindowState extends PersistedWindowState {
  minWidth: number;
  minHeight: number;
}

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const PREFERRED_MIN_WIDTH = 900;
const PREFERRED_MIN_HEIGHT = 600;
const WORK_AREA_INSET = 24;
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 80;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsableBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowBounds>;
  return isFiniteNumber(candidate.x)
    && isFiniteNumber(candidate.y)
    && isFiniteNumber(candidate.width)
    && isFiniteNumber(candidate.height)
    && candidate.width > 0
    && candidate.height > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function visibleOnDisplay(bounds: WindowBounds, display: WindowDisplay): boolean {
  const area = display.workArea;
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  return width >= MIN_VISIBLE_WIDTH && height >= MIN_VISIBLE_HEIGHT;
}

function centeredBounds(area: WindowBounds, width: number, height: number): WindowBounds {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

export function parsePersistedWindowState(value: unknown): PersistedWindowState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PersistedWindowState>;
  if (!isUsableBounds(candidate.bounds) || typeof candidate.isMaximized !== "boolean") return undefined;
  return { bounds: candidate.bounds, isMaximized: candidate.isMaximized };
}

/**
 * Restore a usable placement even when the saved monitor was removed, its DPI changed, or its
 * work area shrank. Window state is convenience data, never authority over visibility.
 */
export function restoreWindowState(
  saved: PersistedWindowState | undefined,
  primaryDisplay: WindowDisplay,
  displays: readonly WindowDisplay[],
): RestoredWindowState {
  const source = saved?.bounds ?? {
    x: primaryDisplay.workArea.x,
    y: primaryDisplay.workArea.y,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  const matchedDisplay = saved ? displays.find((display) => visibleOnDisplay(saved.bounds, display)) : undefined;
  const display = matchedDisplay ?? primaryDisplay;
  const area = display.workArea;
  const insetX = Math.min(WORK_AREA_INSET, Math.floor(Math.max(0, area.width - 1) / 2));
  const insetY = Math.min(WORK_AREA_INSET, Math.floor(Math.max(0, area.height - 1) / 2));
  const maxWidth = Math.max(1, area.width - insetX * 2);
  const maxHeight = Math.max(1, area.height - insetY * 2);
  const width = Math.round(clamp(source.width, 1, maxWidth));
  const height = Math.round(clamp(source.height, 1, maxHeight));
  const minWidth = Math.min(PREFERRED_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(PREFERRED_MIN_HEIGHT, maxHeight);

  if (!matchedDisplay) {
    return {
      bounds: centeredBounds(area, width, height),
      isMaximized: false,
      minWidth,
      minHeight,
    };
  }

  return {
    bounds: {
      x: Math.round(clamp(source.x, area.x + insetX, area.x + area.width - width - insetX)),
      y: Math.round(clamp(source.y, area.y + insetY, area.y + area.height - height - insetY)),
      width,
      height,
    },
    isMaximized: saved?.isMaximized ?? false,
    minWidth,
    minHeight,
  };
}
