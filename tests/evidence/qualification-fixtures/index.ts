// qualification-fixtures/index.ts
// Loader for all qualification fixtures

import { readFileSync } from "node:fs";
import { join, readdirSync } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");

export interface FixtureCase {
  id: string;
  name: string;
  category: string;
  description: string;
  files?: string[];
  [key: string]: any;
}

export interface FixtureCategory {
  name: string;
  cases: FixtureCase[];
}

function loadCase(category: string, filename: string): FixtureCase | null {
  try {
    const filepath = join(__dirname, category, filename);
    const content = readFileSync(filepath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.warn(`Failed to load fixture ${category}/${filename}:`, e);
    return null;
  }
}

export function loadAllFixtures(): FixtureCategory[] {
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

  return categories.map(cat => {
    const catDir = join(__dirname, cat);
    let cases: FixtureCase[] = [];
    try {
      const files = readdirSync(catDir).filter(f => f.endsWith(".json"));
      cases = files.map(f => loadCase(cat, f)).filter((c): c is FixtureCase => c !== null);
    } catch (e) {
      console.warn(`Failed to load category ${cat}:`, e);
    }
    return { name: cat, cases };
  });
}

export function getFixturesByCategory(category: string): FixtureCase[] {
  const all = loadAllFixtures();
  const cat = all.find(c => c.name === category);
  return cat?.cases ?? [];
}

export function getFixtureById(id: string): FixtureCase | undefined {
  for (const cat of loadAllFixtures()) {
    const found = cat.cases.find(c => c.id === id);
    if (found) return found;
  }
  return undefined;
}

export const QUALIFICATION_SUITE_VERSION = "R10_FREE_QUALIFICATION_V1";