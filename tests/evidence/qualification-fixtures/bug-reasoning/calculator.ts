// qualification-fixtures/bug-reasoning/calculator.ts
// Small module with a deliberate bug for bug reasoning test

export interface CalculationResult {
  value: number;
  error?: string;
}

export function divide(a: number, b: number): CalculationResult {
  // BUG: Does not check for division by zero
  return { value: a / b };
}

export function calculateAverage(numbers: number[]): CalculationResult {
  if (numbers.length === 0) {
    return { value: 0, error: "Empty array" };
  }
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return divide(sum, numbers.length);
}

export function safeDivide(a: number, b: number): CalculationResult {
  if (b === 0) {
    return { value: 0, error: "Division by zero" };
  }
  return { value: a / b };
}