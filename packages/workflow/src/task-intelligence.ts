import type { TaskIntent } from "./types.js";
import type { TaskType } from "@codeforge/protocol";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "can", "this", "that", "these", "those", "it", "its", "my", "your",
]);

function tokenize(message: string): string[] {
  return message
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function classifyType(message: string): TaskType {
  const lower = message.toLowerCase();
  if (/(fix|bug|error|fail|broken|crash|exception)/.test(lower)) return "bugfix";
  if (/(add test|write test|test coverage|unit test|e2e)/.test(lower)) return "testing";
  if (/(refactor|clean up|reorganize|rename)/.test(lower)) return "refactoring";
  if (/(document|readme|comment|explain)/.test(lower)) return "documentation";
  if (/(implement|create|add|build|feature|new|support for)/.test(lower)) {
    if (/(multi|several|multiple|across)/.test(lower)) return "multi_file_feature";
    return "implementation";
  }
  if (/(research|investigate|explore|find|search|look)/.test(lower)) return "research";
  if (/(ui|frontend|component|style|layout)/.test(lower)) return "ui";
  if (/(architecture|design|plan|structure)/.test(lower)) return "architecture";
  if (/(debug|diagnose|analyze)/.test(lower)) return "debugging";
  return "implementation";
}

function extractGoals(message: string): string[] {
  const sentences = message
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return [message.trim()];
  return sentences.slice(0, 5);
}

function extractConstraints(message: string): string[] {
  const constraints: string[] = [];
  const lower = message.toLowerCase();
  if (lower.includes("without breaking")) constraints.push("preserve backward compatibility");
  if (lower.includes("test") || lower.includes("verify")) constraints.push("must pass verification");
  if (lower.includes("secure") || lower.includes("secret")) constraints.push("security-sensitive");
  if (lower.includes("quick") || lower.includes("fast")) constraints.push("minimize changes");
  return constraints;
}

function assessRisk(taskType: TaskType, message: string): "low" | "medium" | "high" {
  const lower = message.toLowerCase();
  if (/(delete|remove|drop|destroy|reset|force|migration|schema)/.test(lower)) return "high";
  if (taskType === "bugfix" || taskType === "implementation") return "medium";
  if (taskType === "research" || taskType === "documentation") return "low";
  return "medium";
}

export function understandTask(message: string): TaskIntent {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      rawMessage: message,
      title: "Empty task",
      taskType: "implementation",
      goals: [],
      constraints: [],
      keywords: [],
      risk: "low",
      requiresApproval: false,
    };
  }
  const taskType = classifyType(trimmed);
  const goals = extractGoals(trimmed);
  const constraints = extractConstraints(trimmed);
  const keywords = [...new Set(tokenize(trimmed))].slice(0, 20);
  const risk = assessRisk(taskType, trimmed);
  const requiresApproval = risk !== "low" || taskType === "multi_file_feature" || taskType === "refactoring";
  const title = trimmed.slice(0, 80).split("\n")[0] ?? trimmed.slice(0, 80);

  return {
    rawMessage: message,
    title,
    taskType,
    goals,
    constraints,
    keywords,
    risk,
    requiresApproval,
  };
}

export function isWithinScope(message: string): boolean {
  return message.trim().length > 0 && message.trim().length < 10000;
}
