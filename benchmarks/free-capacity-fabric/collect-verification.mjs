import fs from "node:fs/promises";
import path from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";

const evidencePath = path.resolve(process.argv[2] ?? "docs/evidence/free-capacity-fabric/kilo-autonomous-live.json");
const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
const dbPath = path.join(evidence.workspacePath, "..", `${path.basename(evidence.workspacePath)}.db`);
const persistence = createSessionPersistence({ dbPath });
await persistence.init();
evidence.verificationRecords = await persistence.getWorkItemsByKind("verification");
evidence.routingReceipts = await persistence.getWorkItemsByKind("eight_bit_decision_receipt");
evidence.modelTurns = await persistence.getWorkItemsByKind("agent_model_turn");
delete evidence.verificationAttempts;
await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
await persistence.close();
process.stdout.write(JSON.stringify({ records: evidence.verificationRecords.map((item) => ({ type: item.recordType, status: item.status })), routeReceipts: evidence.routingReceipts.length }) + "\n");
