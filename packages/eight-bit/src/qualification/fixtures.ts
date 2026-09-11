import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureCase } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(__dirname, "..", "..", "..", "tests", "evidence", "qualification-fixtures");

/** Load a single fixture case */
export function loadFixtureCase(category: string, filename: string): FixtureCase | null {
  try {
    const filepath = join(FIXTURES_ROOT, category, filename);
    const content = readFileSync(filepath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.warn(`[qualification] Failed to load fixture ${category}/${filename}:`, e);
    return null;
  }
}

/** Load all fixtures for a category */
export function loadFixturesByCategory(category: string): FixtureCase[] {
  const catDir = join(FIXTURES_ROOT, category);
  try {
    const files = readdirSync(catDir).filter(f => f.endsWith(".json"));
    return files.map(f => loadFixtureCase(category, f)).filter((c): c is FixtureCase => c !== null);
  } catch (e) {
    console.warn(`[qualification] Failed to load category ${category}:`, e);
    return [];
  }
}

/** Load all fixture categories */
export interface FixtureCategory {
  name: string;
  cases: FixtureCase[];
}

export function loadAllFixtureCategories(): FixtureCategory[] {
  const categories = [
    "code-understanding",
    "bug-reasoning",
    "patch-generation",
    "tool-use",
    "read-only",
    "multi-file",
    "structured-output",
    "failure-recovery",
  ];

  return categories.map(cat => ({
    name: cat,
    cases: loadFixturesByCategory(cat),
  }));
}

/** Get fixture file content for a case */
export function getFixtureFiles(category: string, caseFiles: string[] = []): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of caseFiles) {
    try {
      const filepath = join(FIXTURES_ROOT, category, file);
      const content = readFileSync(filepath, "utf-8");
      result.set(file, content);
    } catch (e) {
      console.warn(`[qualification] Failed to load fixture file ${category}/${file}:`, e);
    }
  }
  return result;
}

/** Map roles to relevant fixture categories */
export const ROLE_FIXTURE_CATEGORIES: Record<string, string[]> = {
  CODER: ["code-understanding", "bug-reasoning", "patch-generation", "tool-use", "structured-output", "failure-recovery"],
  TOOL_AGENT: ["tool-use", "structured-output", "failure-recovery", "read-only"],
  ANALYST: ["code-understanding", "bug-reasoning", "multi-file", "read-only"],
  REVIEWER: ["code-understanding", "read-only", "structured-output"],
  PLANNER: ["multi-file", "code-understanding", "read-only"],
  FAST_WORKER: ["tool-use", "structured-output", "failure-recovery"],
  LONG_CONTEXT: ["multi-file", "code-understanding"],
  VISION: [], // Only if VERIFIED_FREE vision model exists
};

/** Get fixture categories for a role */
export function getFixtureCategoriesForRole(role: string): string[] {
  return ROLE_FIXTURE_CATEGORIES[role] ?? [];
}