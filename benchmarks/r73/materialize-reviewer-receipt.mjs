import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRoleQualificationReceipt, ModelQualificationReceiptSchema } from '@codeforge/eight-bit';

const source = process.argv[2];
const destination = process.argv[3];
const raw = await readFile(source, 'utf8');
const evidence = JSON.parse(raw);
const role = evidence.receipt.roleResults.REVIEWER;
if (role.status !== 'QUALIFIED' || evidence.receipt.transientCases > 0) throw new Error('CONCLUSIVE_QUALIFIED_REVIEWER_REQUIRED');
const measured = createRoleQualificationReceipt({ providerId: evidence.providerId, modelId: evidence.modelId, displayName: evidence.catalog.find(model => model.modelId === evidence.modelId).displayName, accessClass: 'FREE_ROUTED', freeStatus: 'verified_free' }, evidence.receipt);
const qualification = ModelQualificationReceiptSchema.parse({
  ...measured,
  metadata: { ...measured.metadata, reviewerProtocolOnly: true, publicCasesOnly: true, evidenceSource: source, evidenceSha256: createHash('sha256').update(raw).digest('hex') },
});
await writeFile(destination, `${JSON.stringify(qualification, null, 2)}\n`);
console.log(JSON.stringify({ destination, reviewer: role.status, score: role.overallScore, requests: evidence.requests }));
