// qualification-fixtures/read-only/analyzer.ts
// Module to analyze - read-only test should not modify this

export interface AnalysisResult {
  lines: number;
  functions: number;
  hasExport: boolean;
}

export function analyzeCode(code: string): AnalysisResult {
  const lines = code.split("\n").length;
  const functionMatches = code.match(/function\s+\w+|const\s+\w+\s*=/g) ?? [];
  const hasExport = code.includes("export ");
  return {
    lines,
    functions: functionMatches.length,
    hasExport,
  };
}

export const SAMPLE_CODE = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

const helper = () => "internal";
`;