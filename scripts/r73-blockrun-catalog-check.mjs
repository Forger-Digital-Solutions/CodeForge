import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mapBlockRunFreeModel } from '../packages/providers/dist/index.js';

const checkedAt = new Date().toISOString();
const response = await fetch('https://blockrun.ai/api/v1/models', { redirect: 'error', signal: AbortSignal.timeout(15_000) });
const body = await response.text();
const data = response.ok ? JSON.parse(body).data : [];
const free = data.filter((model) => model.billing_mode === 'free');
const result = { checkedAt, status: response.status, inferenceRequests: 0, freeModels: free, admissibleModels: free.map(mapBlockRunFreeModel).filter(Boolean), rawBody: body };
const file = `blockrun-catalog-${Date.now()}.json`;
await writeFile(resolve('docs/evidence/r73-free-supply-and-completion', file), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ file, checkedAt, inferenceRequests: 0, status: response.status, freeAvailability: Object.fromEntries(free.map(({ id, available }) => [id, available])), admissibleModels: result.admissibleModels.map(({ modelId }) => modelId) }, null, 2));
