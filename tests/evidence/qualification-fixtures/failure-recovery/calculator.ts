// qualification-fixtures/failure-recovery/calculator.ts
// Calculator with a function that can fail

export interface CalcResult {
  result: number;
  error?: string;
}

export function divide(a: number, b: number): CalcResult {
  if (b === 0) {
    return { result: 0, error: "DIVISION_BY_ZERO" };
  }
  return { result: a / b };
}

export function safeCalculate(expression: string): CalcResult {
  // Simple expression evaluator - can fail
  try {
    // Very basic - just handles "a / b" format
    const parts = expression.split("/");
    if (parts.length !== 2) {
      return { result: 0, error: "INVALID_EXPRESSION" };
    }
    const a = parseFloat(parts[0].trim());
    const b = parseFloat(parts[1].trim());
    return divide(a, b);
  } catch {
    return { result: 0, error: "PARSE_ERROR" };
  }
}