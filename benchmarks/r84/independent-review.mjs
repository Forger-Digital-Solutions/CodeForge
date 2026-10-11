import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createModelReviewer } from "@codeforge/forge-aaa";
import { createKiloFreeDirectAdapter } from "@codeforge/providers";
import { admitFreeRoute } from "../r82/free-route.mjs";

const directory = "docs/evidence/r84-free-cloud-autonomy-certification";
const qualification = JSON.parse(await readFile("docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json", "utf8"));
const role = qualification.qualification?.roleResults?.REVIEWER;
if (role?.status !== "QUALIFIED") throw new Error("Qualified reviewer unavailable");
for (const scope of ["r82", "r83"]) {
  const receipt = { attemptId: randomUUID(), attempt: 1, scope, modelId: qualification.modelId, providerId: qualification.providerId,
    quotaDomain: "kilo:source-ip:shared-unverified", qualification: { providerId: qualification.providerId, status: role.status, suiteVersion: qualification.qualification.suiteVersion, protocolVersion: qualification.qualification.metadata.roleProtocolVersions.REVIEWER, completedAt: role.completedAt, score: role.overallScore },
    startedAt: new Date().toISOString(), classification: "INTERNAL_PUBLIC_SOURCE_EVALUATION_ONLY_NVIDIA_TRIAL", maxPaidSpendUsd: 0, inferenceRequests: 0, rawResponse: "", observations: [], status: "PREFLIGHT" };
  const file = `${directory}/${scope}-review-${receipt.attemptId}.json`;
  const persist = () => writeFile(file, JSON.stringify(receipt, null, 2));
  try {
    const prepared = JSON.parse(await readFile(`${directory}/current-review-packets.json`, 'utf8'))[scope];
    if (!prepared || !/^[a-z0-9-]+\.json$/.test(prepared.file)) throw new Error('Prepare the current deterministic packet before dispatch');
    const packet = await readFile(`${directory}/${prepared.file}`, 'utf8');
    if (createHash('sha256').update(packet).digest('hex') !== prepared.sha256) throw new Error('Prepared packet identity changed');
    if (packet.length > 48000) throw new Error("Review packet exceeds budget; no clipping allowed");
    receipt.packetChars = packet.length;
    receipt.packetSha256 = createHash("sha256").update(packet).digest("hex");
    await writeFile(`${directory}/${scope}-review-packet-${receipt.attemptId}.md`, packet);
    if (!process.argv.includes("--send")) {
      receipt.status = "PREPARED_NOT_SENT";
      receipt.finishedAt = new Date().toISOString(); await persist();
      console.log(JSON.stringify({ file, status: receipt.status, packetChars: receipt.packetChars }));
      continue;
    }
    await admitFreeRoute(receipt.modelId, receipt);
    const transport = createKiloFreeDirectAdapter({ timeoutMs: 150000, fetchFn: async (url, options) => {
      const response = await fetch(url, options);
      receipt.upstreamRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
      return response;
    }, onResponse: (observation) => { receipt.observations.push(observation); } });
    const reviewer = createModelReviewer({ modelId: receipt.modelId, qualification: receipt.qualification, packetMaxChars: 48000, outputMaxTokens: 6000, packetOf: () => packet,
      chat: async (request) => {
        receipt.status = "DISPATCHED"; receipt.inferenceRequests++; receipt.outputMaxTokens = request.maxTokens; await persist();
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
        try {
          for await (const event of transport.streamChat(request, controller.signal)) {
            if (event.type === "text_delta") { receipt.rawResponse += event.delta; await persist(); }
            else if (event.type === "usage") receipt.usage = event.usage;
            else if (event.type === "finish") { receipt.finishReason = event.finishReason; receipt.servedModel = event.model; }
            else if (event.type === "error") { receipt.upstreamError = event; throw new Error(`${event.code}: ${event.message}`); }
          }
          if (controller.signal.aborted) throw new Error("Review deadline exceeded");
          return { text: receipt.rawResponse, finishReason: receipt.finishReason, modelId: receipt.servedModel, requestId: receipt.upstreamRequestId, quotaDomain: receipt.quotaDomain, usage: receipt.usage };
        } finally { clearTimeout(timer); await persist(); }
      },
    });
    receipt.review = await reviewer({});
    receipt.status = receipt.review.independent ? "INDEPENDENTLY_REVIEWED" : "BLOCKED";
  } catch (error) { receipt.status = "BLOCKED"; receipt.error = String(error); }
  receipt.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ file, status: receipt.status, approved: receipt.review?.approved, finishReason: receipt.finishReason, error: receipt.error, findings: receipt.review?.findings }));
}
