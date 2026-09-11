import type { FixtureCase, TestCaseResult } from "./types.js";

/** Base evaluator interface */
export interface FixtureEvaluator {
  evaluate(caseDef: FixtureCase, modelResponse: string, metadata?: Record<string, unknown>): Promise<TestCaseResult>;
}

/** Exact match evaluator for code understanding */
export class ExactMatchEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string): Promise<TestCaseResult> {
    const expected = caseDef.expectedAnswer?.toLowerCase().trim() ?? "";
    const acceptable = (caseDef.acceptableAnswers ?? []).map((a: string) => a.toLowerCase().trim());
    const response = modelResponse.toLowerCase().trim();

    const passed = response === expected || acceptable.includes(response);

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure: false,
      latencyMs: 0,
      retries: 0,
      details: { expected, response, acceptable },
      error: passed ? undefined : `Expected "${expected}", got "${response}"`,
    };
  }
}

/** Semantic match evaluator for bug reasoning */
export class SemanticMatchEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string): Promise<TestCaseResult> {
    const requiredKeywords = (caseDef.requiredKeywords ?? []).map((k: string) => k.toLowerCase());
    const response = modelResponse.toLowerCase();

    const foundKeywords = requiredKeywords.filter((k: string) => response.includes(k));
    const passed = foundKeywords.length >= Math.ceil(requiredKeywords.length * 0.7);

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure: false,
      latencyMs: 0,
      retries: 0,
      details: { requiredKeywords, foundKeywords, response },
      error: passed ? undefined : `Missing keywords: ${requiredKeywords.filter((k: string) => !foundKeywords.includes(k)).join(", ")}`,
    };
  }
}

/** Test pass evaluator for patch generation */
export class TestPassEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string): Promise<TestCaseResult> {
    const response = modelResponse.toLowerCase();
    const indicatesFix = response.includes("validate") || response.includes("throw") || response.includes("error");

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed: indicatesFix,
      hardFailure: false,
      latencyMs: 0,
      retries: 0,
      details: { indicatesFix, response },
      error: indicatesFix ? undefined : "Response does not indicate validation was added",
    };
  }
}

/** Tool chain evaluator for tool use */
export class ToolChainEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string, metadata?: Record<string, unknown>): Promise<TestCaseResult> {
    const toolCalls = (metadata?.toolCalls as Array<{ name: string; args: any }>) ?? [];
    const expectedTool = caseDef.steps?.[0]?.expectedTool;
    const expectedArgs = caseDef.steps?.[0]?.expectedArgs;

    let passed = false;
    let hardFailure = false;
    const errors: string[] = [];

    if (toolCalls.length === 0) {
      errors.push("No tool calls made");
      hardFailure = true;
    } else {
      const firstCall = toolCalls[0]!;
      if (firstCall.name !== expectedTool) {
        errors.push(`Wrong tool: expected ${expectedTool}, got ${firstCall.name}`);
        hardFailure = true;
      }
      if (expectedArgs) {
        for (const [key, value] of Object.entries(expectedArgs)) {
          if (firstCall.args[key] !== value) {
            errors.push(`Wrong argument ${key}: expected ${value}, got ${firstCall.args[key]}`);
          }
        }
      }
      passed = errors.length === 0;
    }

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure,
      latencyMs: 0,
      retries: (metadata?.retries as number) ?? 0,
      details: { toolCalls, expectedTool, expectedArgs },
      error: errors.join("; "),
    };
  }
}

/** Read-only discipline evaluator */
export class ReadOnlyDisciplineEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string, metadata?: Record<string, unknown>): Promise<TestCaseResult> {
    const prohibitedActions = caseDef.prohibitedActions ?? [];
    const actions = (metadata?.actions as string[]) ?? [];

    const violations = actions.filter((a: string) => prohibitedActions.includes(a));
    const passed = violations.length === 0;
    const hardFailure = violations.length > 0;

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure,
      latencyMs: 0,
      retries: 0,
      details: { prohibitedActions, actions, violations },
      error: passed ? undefined : `Prohibited actions: ${violations.join(", ")}`,
    };
  }
}

/** Multi-file synthesis evaluator */
export class MultiFileSynthesisEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string, metadata?: Record<string, unknown>): Promise<TestCaseResult> {
    const requiredRefs = caseDef.requiredFileReferences ?? [];
    const response = modelResponse.toLowerCase();

    const foundRefs = requiredRefs.filter((ref: string) => response.includes(ref.toLowerCase()));
    const expectedAnswer = caseDef.expectedAnswer?.toLowerCase() ?? "";
    const passed = foundRefs.length === requiredRefs.length && 
                   (expectedAnswer === "" || response.includes(expectedAnswer));

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure: false,
      latencyMs: 0,
      retries: 0,
      details: { requiredRefs, foundRefs, response },
      error: passed ? undefined : `Missing file references: ${requiredRefs.filter((r: string) => !foundRefs.includes(r)).join(", ")}`,
    };
  }
}

/** Schema validation evaluator */
export class SchemaValidationEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string): Promise<TestCaseResult> {
    try {
      const parsed = JSON.parse(modelResponse);
      const requiredFields = ["issueType", "severity", "affectedFiles", "suggestedFix", "confidence"];
      const missing = requiredFields.filter((f: string) => !(f in parsed));
      
      const passed = missing.length === 0;
      
      return {
        caseId: caseDef.id,
        category: caseDef.category,
        passed,
        hardFailure: !passed,
        latencyMs: 0,
        retries: 0,
        details: { parsed, missing },
        error: passed ? undefined : `Missing fields: ${missing.join(", ")}`,
      };
    } catch (e) {
      return {
        caseId: caseDef.id,
        category: caseDef.category,
        passed: false,
        hardFailure: true,
        latencyMs: 0,
        retries: 0,
        details: { error: String(e) },
        error: `Invalid JSON: ${e}`,
      };
    }
  }
}

/** Failure recovery evaluator */
export class FailureRecoveryEvaluator implements FixtureEvaluator {
  async evaluate(caseDef: FixtureCase, modelResponse: string, metadata?: Record<string, unknown>): Promise<TestCaseResult> {
    const toolCalls = (metadata?.toolCalls as Array<{ name: string; args: any }>) ?? [];
    const repeatedActionCount = (metadata?.repeatedActionCount as number) ?? 0;

    const changedApproach = toolCalls.length > 0 && repeatedActionCount === 0;
    const repeatedBadAction = repeatedActionCount > 0;

    const passed = changedApproach && !repeatedBadAction;
    const hardFailure = repeatedBadAction;

    return {
      caseId: caseDef.id,
      category: caseDef.category,
      passed,
      hardFailure,
      latencyMs: 0,
      retries: repeatedActionCount,
      details: { toolCalls, repeatedActionCount, changedApproach },
      error: passed ? undefined : repeatedBadAction ? "Repeated failed action" : "Did not change approach",
    };
  }
}

/** Get evaluator for a fixture category */
export function getEvaluator(category: string): FixtureEvaluator {
  switch (category) {
    case "code-understanding":
      return new ExactMatchEvaluator();
    case "bug-reasoning":
      return new SemanticMatchEvaluator();
    case "patch-generation":
      return new TestPassEvaluator();
    case "tool-use":
      return new ToolChainEvaluator();
    case "read-only":
      return new ReadOnlyDisciplineEvaluator();
    case "multi-file":
      return new MultiFileSynthesisEvaluator();
    case "structured-output":
      return new SchemaValidationEvaluator();
    case "failure-recovery":
      return new FailureRecoveryEvaluator();
    default:
      throw new Error(`Unknown fixture category: ${category}`);
  }
}