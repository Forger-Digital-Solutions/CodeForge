import type { ActivityKind } from "./activity-icons.js";

/**
 * Presentation-level icon theme for the activity stream.
 * `8bit` is the default visual set (8-Bit mascot emojis);
 * `legacyForge` preserves the previous forge-object set for rollback/theming.
 * This is rendering only — runtime event semantics are unaffected.
 */
export type ActivityEmojiTheme = "8bit" | "legacyForge";

export const ACTIVITY_EMOJI_THEMES = ["8bit", "legacyForge"] as const;

export const DEFAULT_ACTIVITY_EMOJI_THEME: ActivityEmojiTheme = "8bit";

export function resolveActivityEmojiTheme(theme?: string | null): ActivityEmojiTheme {
  return theme === "legacyForge" ? "legacyForge" : DEFAULT_ACTIVITY_EMOJI_THEME;
}

const URL_8BIT = (name: string) => new URL(`./assets/activity-emoji/8bit/20/${name}.png`, import.meta.url).href;
const URL_LEGACY = (name: string) => new URL(`./assets/emojipack/20/${name}.png`, import.meta.url).href;

const ASSET_URLS = {
  "approval-forge-seal": URL_LEGACY("approval-forge-seal"),
  "build-forge-furnace": URL_LEGACY("build-forge-furnace"),
  "cancelled-forge-tool": URL_LEGACY("cancelled-forge-tool"),
  "command-execution-welding-torch": URL_LEGACY("command-execution-welding-torch"),
  "complete-finished-blade": URL_LEGACY("complete-finished-blade"),
  "create-file-css": URL_LEGACY("create-file-css"),
  "create-file-generic": URL_LEGACY("create-file-generic"),
  "create-file-html": URL_LEGACY("create-file-html"),
  "create-file-javascript": URL_LEGACY("create-file-javascript"),
  "create-file-json": URL_LEGACY("create-file-json"),
  "create-file-markdown": URL_LEGACY("create-file-markdown"),
  "create-file-powershell": URL_LEGACY("create-file-powershell"),
  "create-file-python": URL_LEGACY("create-file-python"),
  "create-file-rust": URL_LEGACY("create-file-rust"),
  "create-file-shell": URL_LEGACY("create-file-shell"),
  "create-file-sql": URL_LEGACY("create-file-sql"),
  "create-file-toml": URL_LEGACY("create-file-toml"),
  "create-file-typescript": URL_LEGACY("create-file-typescript"),
  "create-file-xml": URL_LEGACY("create-file-xml"),
  "create-file-yaml": URL_LEGACY("create-file-yaml"),
  "edit-engraving-chisel": URL_LEGACY("edit-engraving-chisel"),
  "error-broken-blade": URL_LEGACY("error-broken-blade"),
  "fetch-forge-tongs": URL_LEGACY("fetch-forge-tongs"),
  "git-chain-links": URL_LEGACY("git-chain-links"),
  "paused-raised-hammer": URL_LEGACY("paused-raised-hammer"),
  "planning-blueprint-protractor": URL_LEGACY("planning-blueprint-protractor"),
  "queued-cooling-metal": URL_LEGACY("queued-cooling-metal"),
  "read-monocle-reader": URL_LEGACY("read-monocle-reader"),
  "reasoning-three-gears": URL_LEGACY("reasoning-three-gears"),
  "search-metal-detector": URL_LEGACY("search-metal-detector"),
  "test-quench": URL_LEGACY("test-quench"),
  "tool-use-hammer-anvil": URL_LEGACY("tool-use-hammer-anvil"),
  "verify-inspection": URL_LEGACY("verify-inspection"),
  "warning-cracked-metal": URL_LEGACY("warning-cracked-metal"),
  "8bit-analyzing": URL_8BIT("8bit-analyzing"),
  "8bit-build": URL_8BIT("8bit-build"),
  "8bit-cancelled": URL_8BIT("8bit-cancelled"),
  "8bit-coding": URL_8BIT("8bit-coding"),
  "8bit-configuring": URL_8BIT("8bit-configuring"),
  "8bit-create-file": URL_8BIT("8bit-create-file"),
  "8bit-delete-file": URL_8BIT("8bit-delete-file"),
  "8bit-dependency-graph": URL_8BIT("8bit-dependency-graph"),
  "8bit-downloading": URL_8BIT("8bit-downloading"),
  "8bit-edit-file": URL_8BIT("8bit-edit-file"),
  "8bit-error": URL_8BIT("8bit-error"),
  "8bit-executing": URL_8BIT("8bit-executing"),
  "8bit-fetch": URL_8BIT("8bit-fetch"),
  "8bit-file-generic": URL_8BIT("8bit-file-generic"),
  "8bit-file-javascript": URL_8BIT("8bit-file-javascript"),
  "8bit-file-python": URL_8BIT("8bit-file-python"),
  "8bit-file-rust": URL_8BIT("8bit-file-rust"),
  "8bit-file-typescript": URL_8BIT("8bit-file-typescript"),
  "8bit-git": URL_8BIT("8bit-git"),
  "8bit-idea": URL_8BIT("8bit-idea"),
  "8bit-idle": URL_8BIT("8bit-idle"),
  "8bit-list-files": URL_8BIT("8bit-list-files"),
  "8bit-loading": URL_8BIT("8bit-loading"),
  "8bit-model-selection": URL_8BIT("8bit-model-selection"),
  "8bit-multi-model": URL_8BIT("8bit-multi-model"),
  "8bit-offline": URL_8BIT("8bit-offline"),
  "8bit-online": URL_8BIT("8bit-online"),
  "8bit-paused": URL_8BIT("8bit-paused"),
  "8bit-planning": URL_8BIT("8bit-planning"),
  "8bit-read": URL_8BIT("8bit-read"),
  "8bit-reasoning": URL_8BIT("8bit-reasoning"),
  "8bit-running-command": URL_8BIT("8bit-running-command"),
  "8bit-search": URL_8BIT("8bit-search"),
  "8bit-success": URL_8BIT("8bit-success"),
  "8bit-swapping-model": URL_8BIT("8bit-swapping-model"),
  "8bit-testing": URL_8BIT("8bit-testing"),
  "8bit-thinking": URL_8BIT("8bit-thinking"),
  "8bit-thumbs-up": URL_8BIT("8bit-thumbs-up"),
  "8bit-tool-use": URL_8BIT("8bit-tool-use"),
  "8bit-updating": URL_8BIT("8bit-updating"),
  "8bit-uploading": URL_8BIT("8bit-uploading"),
  "8bit-verifying": URL_8BIT("8bit-verifying"),
  "8bit-warning": URL_8BIT("8bit-warning"),
  "8bit-waiting": URL_8BIT("8bit-waiting"),
} as const;

export type ActivityAssetName = keyof typeof ASSET_URLS;

type KindAssetMap = Partial<Record<ActivityKind, ActivityAssetName>>;

const ASSET_BY_KIND: Record<ActivityEmojiTheme, KindAssetMap> = {
  "8bit": {
    search: "8bit-search", read: "8bit-read", reason: "8bit-reasoning", plan: "8bit-planning",
    edit: "8bit-edit-file", delete: "8bit-delete-file", tool: "8bit-tool-use",
    execute: "8bit-running-command", forge: "8bit-running-command", fetch: "8bit-fetch",
    build: "8bit-build", test: "8bit-testing", verify: "8bit-verifying", git: "8bit-git",
    commit: "8bit-git", error: "8bit-error", waiting: "8bit-waiting", queued: "8bit-waiting",
    paused: "8bit-paused", approval: "8bit-thumbs-up", complete: "8bit-success",
    success: "8bit-success", warning: "8bit-warning", cancelled: "8bit-cancelled",
    parallel: "8bit-multi-model", generic: "8bit-tool-use", unknown: "8bit-tool-use",
  },
  legacyForge: {
    search: "search-metal-detector", read: "read-monocle-reader", reason: "reasoning-three-gears",
    plan: "planning-blueprint-protractor", edit: "edit-engraving-chisel", delete: "cancelled-forge-tool",
    tool: "tool-use-hammer-anvil", execute: "command-execution-welding-torch", forge: "command-execution-welding-torch",
    fetch: "fetch-forge-tongs", build: "build-forge-furnace", test: "test-quench", verify: "verify-inspection",
    git: "git-chain-links", commit: "git-chain-links", error: "error-broken-blade", waiting: "queued-cooling-metal",
    queued: "queued-cooling-metal", paused: "paused-raised-hammer", approval: "approval-forge-seal",
    complete: "complete-finished-blade", success: "complete-finished-blade", warning: "warning-cracked-metal",
    cancelled: "cancelled-forge-tool", parallel: "tool-use-hammer-anvil", generic: "tool-use-hammer-anvil",
    unknown: "tool-use-hammer-anvil",
  },
};

const FILE_ASSET_BY_EXTENSION: Record<ActivityEmojiTheme, Record<string, ActivityAssetName>> = {
  "8bit": {
    ts: "8bit-file-typescript", tsx: "8bit-file-typescript",
    js: "8bit-file-javascript", jsx: "8bit-file-javascript", mjs: "8bit-file-javascript", cjs: "8bit-file-javascript",
    py: "8bit-file-python",
    rs: "8bit-file-rust",
  },
  legacyForge: {
    css: "create-file-css", html: "create-file-html", htm: "create-file-html", js: "create-file-javascript",
    jsx: "create-file-javascript", json: "create-file-json", md: "create-file-markdown", mdx: "create-file-markdown",
    ps1: "create-file-powershell", py: "create-file-python", rs: "create-file-rust", sh: "create-file-shell",
    bash: "create-file-shell", sql: "create-file-sql", toml: "create-file-toml", ts: "create-file-typescript",
    tsx: "create-file-typescript", xml: "create-file-xml", yaml: "create-file-yaml", yml: "create-file-yaml",
  },
};

const GENERIC_CREATE_ASSET: Record<ActivityEmojiTheme, ActivityAssetName> = {
  "8bit": "8bit-create-file",
  legacyForge: "create-file-generic",
};

const KIND_FALLBACK_ASSET: Record<ActivityEmojiTheme, ActivityAssetName> = {
  "8bit": "8bit-tool-use",
  legacyForge: "tool-use-hammer-anvil",
};

export function resolveFileAssetName(filePath?: string, theme: ActivityEmojiTheme = DEFAULT_ACTIVITY_EMOJI_THEME): ActivityAssetName {
  const fileName = filePath?.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return FILE_ASSET_BY_EXTENSION[theme][extension] ?? GENERIC_CREATE_ASSET[theme];
}

export function resolveActivityAssetName(kind: ActivityKind, filePath?: string, theme: ActivityEmojiTheme = DEFAULT_ACTIVITY_EMOJI_THEME): ActivityAssetName {
  return kind === "create" ? resolveFileAssetName(filePath, theme) : ASSET_BY_KIND[theme][kind] ?? KIND_FALLBACK_ASSET[theme];
}

export function resolveActivityAsset(kind: ActivityKind, filePath?: string, theme: ActivityEmojiTheme = DEFAULT_ACTIVITY_EMOJI_THEME): string {
  return ASSET_URLS[resolveActivityAssetName(kind, filePath, theme)];
}

/** Resolves any known asset name directly to its bundled URL — used by non-ActivityKind
 * consumers (e.g. 8-Bit status, which maps its own event vocabulary to certified assets). */
export function resolveAssetUrlByName(name: ActivityAssetName): string {
  return ASSET_URLS[name];
}
