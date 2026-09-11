import type {
  FreeModelRecord,
  ModelQualificationReceipt,
  QualificationConfig,
  RoleQualificationResult,
  TestCaseResult,
} from "./types.js";
import { QUALIFICATION_SUITE_VERSION, DEFAULT_QUALIFICATION_CONFIG } from "./types.js";
import { EightBitRoleSchema } from "../types.js";
import type { EightBitRole } from "../types.js";
import { loadFixturesByCategory, getFixtureCategoriesForRole, getFixtureFiles } from "./fixtures.js";
import { getEvaluator } from "./evaluators.js";
import type { FixtureCase } from "./types.js";

export interface ModelQualificationRunnerOptions {
  config?: Partial<QualificationConfig>;
  onProgress?: (progress: { role: string; caseId: string; passed: boolean }) => void;
}

/** Main qualification runner */
export class ModelQualificationRunner {
  private readonly config: QualificationConfig;

  constructor(options: ModelQualificationRunnerOptions = {}) {
    this.config = { ...DEFAULT_QUALIFICATION_CONFIG, ...options.config };
    if (options.onProgress) {
      this.config.onProgress = options.onProgress;
    }
  }

  /** Run full qualification for a model */
  async qualify(model: FreeModelRecord, provider: any): Promise<ModelQualificationReceipt> {
    const startedAt = new Date().toISOString();
    const roleResults: Record<string, RoleQualificationResult> = {};
    const hardFailureRoles: EightBitRole[] = [];
    let totalLatencyMs = 0;
    let totalCalls = 0;

    // Determine which roles to test based on model capabilities
    const rolesToTest = this.config.roles ?? this.inferRoles(model);
    console.log(`[qualification] Qualifying ${model.providerId}/${model.modelId} for roles: ${rolesToTest.join(", ")}`);

    for (const role of rolesToTest) {
      const roleStart = Date.now();
      const result = await this.qualifyForRole(model, provider, role, totalLatencyMs);
      roleResults[role] = result;
      totalLatencyMs += Date.now() - roleStart;

      if (result.hardFailures.length > 0) {
        hardFailureRoles.push(role as EightBitRole);
      }
      
      // Track budget
      totalCalls += result.testCases.length;
      if (this.config.budget?.maxTotalCalls && totalCalls > this.config.budget.maxTotalCalls) {
        console.warn(`[qualification] Budget exceeded, stopping`);
        break;
      }
      
      if (this.config.budget?.maxWallTimeMs && totalLatencyMs > this.config.budget.maxWallTimeMs) {
        console.warn(`[qualification] Wall time budget exceeded, stopping`);
        break;
      }
    }

    const completedAt = new Date().toISOString();

    // Determine overall qualification state
    const qualifiedRoles = Object.entries(roleResults).filter(([_, r]) => r.status === "QUALIFIED").length;
    const totalRoles = Object.keys(roleResults).length;
    const qualificationState = this.determineQualificationState(roleResults, hardFailureRoles);

    const receipt: ModelQualificationReceipt = {
      suiteVersion: QUALIFICATION_SUITE_VERSION,
      providerId: model.providerId,
      modelId: model.modelId,
      modelDisplayName: model.displayName,
      accessClass: model.accessClass ?? "UNKNOWN",
      freeStatus: model.freeStatus,
      roleResults,
      startedAt,
      completedAt,
      totalLatencyMs,
      qualificationState,
      hardFailureRoles,
      metadata: {
        totalCalls,
        rolesTested: rolesToTest,
      },
    };

    return receipt;
  }

  /** Infer roles from model capabilities */
  private inferRoles(model: FreeModelRecord): EightBitRole[] {
    const roles: EightBitRole[] = [];
    
    if (model.capabilities.toolCalling) roles.push("TOOL_AGENT");
    if (model.capabilities.coding) roles.push("CODER");
    if (model.capabilities.vision) roles.push("VISION");
    if (model.capabilities.longContext || (model.contextWindow ?? 0) >= 100000) roles.push("LONG_CONTEXT");
    
    // Always include base roles
    roles.push("ANALYST", "REVIEWER", "PLANNER", "FAST_WORKER");
    
    return [...new Set(roles)];
  }

  /** Qualify model for a specific role */
  private async qualifyForRole(
    model: FreeModelRecord,
    provider: any,
    role: EightBitRole,
    totalLatencyMs: number
  ): Promise<RoleQualificationResult> {
    const categories = getFixtureCategoriesForRole(role);
    const allCases: FixtureCase[] = [];
    
    for (const cat of categories) {
      const cases = loadFixturesByCategory(cat);
      allCases.push(...cases);
    }

    if (allCases.length === 0) {
      return {
        role,
        status: "NOT_TESTED",
        testCases: [],
        hardFailures: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    const testCases: TestCaseResult[] = [];
    const hardFailures: string[] = [];

    for (const caseDef of allCases) {
      const caseStart = Date.now();
      
      try {
        const result = await this.runCase(model, provider, caseDef, role);
        result.latencyMs = Date.now() - caseStart;
        testCases.push(result);
        
        if (result.hardFailure) {
          hardFailures.push(caseDef.id);
        }

        this.config.onProgress?.({ role, caseId: caseDef.id, passed: result.passed });
      } catch (e) {
        const errorResult: TestCaseResult = {
          caseId: caseDef.id,
          category: caseDef.category,
          passed: false,
          hardFailure: true,
          latencyMs: Date.now() - caseStart,
          retries: 0,
          error: String(e),
        };
        testCases.push(errorResult);
        hardFailures.push(caseDef.id);
      }

      // Budget check
      if (this.config.budget?.maxWallTimeMs && totalLatencyMs > this.config.budget.maxWallTimeMs) {
        break;
      }
    }

    // Determine role status
    const passedCount = testCases.filter(t => t.passed).length;
    const totalCount = testCases.length;
    const hasHardFailure = hardFailures.length > 0;
    const overallScore = totalCount > 0 ? passedCount / totalCount : 0;

    let status: RoleQualificationResult["status"];
    if (hasHardFailure) {
      status = "HARD_FAILURE";
    } else if (overallScore >= 0.8 && passedCount > 0) {
      status = "QUALIFIED";
    } else if (overallScore >= 0.5) {
      status = "PROBATION";
    } else {
      status = "NOT_QUALIFIED";
    }

    return {
      role,
      status,
      testCases,
      hardFailures,
      overallScore,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  /** Run a single test case */
  private async runCase(
    model: FreeModelRecord,
    provider: any,
    caseDef: FixtureCase,
    role: EightBitRole
  ): Promise<TestCaseResult> {
    const evaluator = getEvaluator(caseDef.category);
    const fixtureFiles = getFixtureFiles(caseDef.category, caseDef.files ?? []);
    
    // Build prompt with fixture context
    const prompt = this.buildPrompt(caseDef, fixtureFiles);
    
    // Call model
    const req = {
      model: model.modelId,
      messages: [
        { role: "system", content: this.getSystemPrompt(role) },
        { role: "user", content: prompt },
      ],
      maxTokens: 2048,
      temperature: 0.1,
    };

    let response = "";
    let retries = 0;
    let metadata: Record<string, unknown> = {};

    for (let attempt = 0; attempt <= (this.config.maxRetries ?? 2); attempt++) {
      try {
        const result = await provider.chat(req);
        response = result.choices?.[0]?.message?.content ?? "";
        
        // Extract tool calls if any
        if (result.choices?.[0]?.message?.toolCalls) {
          metadata.toolCalls = result.choices[0].message.toolCalls;
        }
        
        // Check if response indicates we should retry
        if (this.shouldRetry(caseDef, response)) {
          retries++;
          continue;
        }
        
        break;
      } catch (e) {
        if (attempt === (this.config.maxRetries ?? 2)) throw e;
        retries++;
      }
    }

    metadata.retries = retries;
    const result = await evaluator.evaluate(caseDef, response, metadata);
    result.retries = retries;
    
    return result;
  }

  /** Build prompt for a test case */
  private buildPrompt(caseDef: FixtureCase, fixtureFiles: Map<string, string>): string {
    let prompt = `Test Case: ${caseDef.name}\n${caseDef.description}\n\n`;

    if (fixtureFiles.size > 0) {
      prompt += "Relevant files:\n";
      for (const [filename, content] of fixtureFiles) {
        prompt += `\n--- ${filename} ---\n${content}\n`;
      }
      prompt += "\n";
    }

    if (caseDef.question) {
      prompt += `Question: ${caseDef.question}\n`;
    }
    if (caseDef.instruction) {
      prompt += `Instruction: ${caseDef.instruction}\n`;
    }
    if (caseDef.task) {
      prompt += `Task: ${caseDef.task}\n`;
    }
    if (caseDef.scenario) {
      prompt += `Scenario: ${JSON.stringify(caseDef.scenario, null, 2)}\n`;
    }

    // Add schema if structured output
    if (caseDef.schemaFile && caseDef.schemaName) {
      prompt += `\nOutput must match the ${caseDef.schemaName} schema from ${caseDef.schemaFile}.\n`;
    }

    return prompt;
  }

  /** System prompt for role */
  private getSystemPrompt(role: EightBitRole): string {
    const base = "You are being evaluated for CodeForge qualification. Follow instructions precisely.";
    const rolePrompts: Record<string, string> = {
      CODER: "Focus on writing correct, minimal code changes. Use tools when instructed.",
      TOOL_AGENT: "You MUST use the provided tools. Do not hallucinate tool names. Output valid tool calls.",
      ANALYST: "Provide accurate analysis based only on provided context. Do not invent facts.",
      REVIEWER: "Review the provided code/changes. Be thorough but concise.",
      READ_ONLY: "EXPLAIN ONLY. Do not modify files. Do not run mutation commands.",
    };
    return `${base} ${rolePrompts[role] ?? ""}`;
  }

  /** Check if response indicates retry needed */
  private shouldRetry(caseDef: FixtureCase, response: string): boolean {
    // For structured output, check if JSON is valid
    if (caseDef.category === "structured-output") {
      try {
        JSON.parse(response);
        return false;
      } catch {
        return true;
      }
    }
    return false;
  }

  /** Determine overall qualification state */
  private determineQualificationState(
    roleResults: Record<string, RoleQualificationResult>,
    hardFailureRoles: EightBitRole[]
  ): ModelQualificationReceipt["qualificationState"] {
    if (hardFailureRoles.length > 0) return "HARD_FAILURE";
    
    const qualifiedCount = Object.values(roleResults).filter(r => r.status === "QUALIFIED").length;
    const totalCount = Object.keys(roleResults).length;
    
    if (qualifiedCount === totalCount && totalCount > 0) return "QUALIFIED";
    if (qualifiedCount > 0) return "PROBATION";
    return "NOT_QUALIFIED";
  }
}

/** Run qualification and persist receipt */
export async function runModelQualification(
  model: FreeModelRecord,
  provider: any,
  options: ModelQualificationRunnerOptions = {}
): Promise<ModelQualificationReceipt> {
  const runner = new ModelQualificationRunner(options);
  return runner.qualify(model, provider);
}