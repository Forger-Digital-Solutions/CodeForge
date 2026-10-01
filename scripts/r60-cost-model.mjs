import { readFile, writeFile } from "node:fs/promises";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  process.stderr.write("Usage: node scripts/r60-cost-model.mjs <measured-input.json> <output.json>\n");
  process.exitCode = 2;
} else {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const required = ["gpuHourlyPriceUsd", "measuredUsableTokensPerSecond", "averageUtilization", "averageInputTokensPerRequest", "averageOutputTokensPerRequest", "cacheHitRate", "batchEfficiency", "idlePercentage", "minWorkers", "workerCount", "averageRequestsPerUserPerDay", "averageRequestsPerActiveDeveloperHour"];
  const missing = required.filter((key) => typeof input[key] !== "number" || !Number.isFinite(input[key]));
  if (missing.length) throw new Error(`Missing numeric measured input(s): ${missing.join(", ")}`);
  const ratioKeys = ["averageUtilization", "cacheHitRate", "batchEfficiency", "idlePercentage"];
  for (const key of ratioKeys) if (input[key] < 0 || input[key] > 1) throw new Error(`${key} must be in [0,1]`);
  if (input.gpuHourlyPriceUsd <= 0 || input.measuredUsableTokensPerSecond <= 0 || input.minWorkers < 0 || input.workerCount < 0) throw new Error("Price, throughput and worker counts are outside valid ranges");
  if (input.averageInputTokensPerRequest <= 0 || input.averageOutputTokensPerRequest < 0 || input.averageRequestsPerUserPerDay <= 0 || input.averageRequestsPerActiveDeveloperHour < 0) throw new Error("Workload volume values are outside valid ranges");

  const hoursPerMonth = 730;
  const weightedCreditsPerRequest = input.averageInputTokensPerRequest * (1 - input.cacheHitRate * 0.5) + 2 * input.averageOutputTokensPerRequest;
  const workloadTokensPerRequest = input.averageInputTokensPerRequest + input.averageOutputTokensPerRequest;
  if (workloadTokensPerRequest <= 0 || input.averageRequestsPerActiveDeveloperHour < 0) throw new Error("Workload tokens and active developer request rate must be non-negative");
  const weightedCreditPerToken = weightedCreditsPerRequest / workloadTokensPerRequest;
  const effectiveCreditsPerSecond = input.measuredUsableTokensPerSecond * weightedCreditPerToken * input.averageUtilization * input.batchEfficiency * (1 - input.idlePercentage);
  const creditsPerWorkerMonth = effectiveCreditsPerSecond * 3600 * hoursPerMonth;
  const costPerMillionCredits = input.gpuHourlyPriceUsd * hoursPerMonth / creditsPerWorkerMonth * 1_000_000;
  const monthlyCreditsPerUser = weightedCreditsPerRequest * input.averageRequestsPerUserPerDay * 30;
  const results = {};
  for (const users of [100, 1000, 10000]) {
    const demand = users * monthlyCreditsPerUser;
    const workers = Math.max(input.minWorkers, Math.ceil(demand / creditsPerWorkerMonth));
    results[users] = {
      desiredWorkers: workers,
      estimatedMonthlyInfrastructureCostUsd: Number((workers * input.gpuHourlyPriceUsd * hoursPerMonth).toFixed(2)),
      estimatedCostPerUserUsd: Number((workers * input.gpuHourlyPriceUsd * hoursPerMonth / users).toFixed(4)),
    };
  }
  const output = {
    classification: "MODEL_FROM_OPERATOR_INPUTS; NOT_PHYSICAL_PROOF",
    input,
    formulas: {
      effectiveCreditsPerSecond: "measuredUsableTokensPerSecond * workloadWeightedCreditsPerToken * averageUtilization * batchEfficiency * (1 - idlePercentage)",
      weightedCreditsPerRequest: "averageInputTokensPerRequest * (1 - cacheHitRate * 0.5) + 2 * averageOutputTokensPerRequest",
      costPerMillionWeightedCredits: "gpuHourlyPriceUsd * 730 / (effectiveCreditsPerSecond * 3600) * 1,000,000",
      costPerMillionInputTokens: "costPerMillionWeightedCredits * weightedCreditsPerRequest / averageInputTokensPerRequest",
      costPerMillionOutputTokens: "costPerMillionWeightedCredits * 2",
      costPerActiveDeveloperHour: "estimatedCostPerRequest * averageRequestsPerActiveDeveloperHour",
      desiredWorkers: "max(minWorkers, ceil(users * monthlyCreditsPerUser / creditsPerWorkerMonth))",
    },
    outputs: {
      effectiveCreditsPerSecond,
      weightedCreditPerToken,
      weightedCreditsPerRequest,
      costPerMillionWeightedCreditsUsd: costPerMillionCredits,
      costPerMillionInputTokensUsd: Number((costPerMillionCredits * weightedCreditsPerRequest / input.averageInputTokensPerRequest).toFixed(6)),
      costPerMillionOutputTokensUsd: Number((costPerMillionCredits * 2).toFixed(6)),
      estimatedCostPerRequestUsd: costPerMillionCredits * weightedCreditsPerRequest / 1_000_000,
      estimatedCostPerActiveDeveloperHourUsd: Number((costPerMillionCredits * weightedCreditsPerRequest / 1_000_000 * input.averageRequestsPerActiveDeveloperHour).toFixed(6)),
      configuredFleetMonthlyInfrastructureCostUsd: Number((input.workerCount * input.gpuHourlyPriceUsd * hoursPerMonth).toFixed(2)),
      configuredFleetMonthlyCapacityWeightedCredits: Math.floor(input.workerCount * creditsPerWorkerMonth),
      estimatedUsersPerWorker: Math.floor(creditsPerWorkerMonth / monthlyCreditsPerUser),
      measuredConcurrentAgentsPerWorker: input.measuredConcurrentAgentsPerWorker ?? null,
      monthlyScenarios: results,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}
