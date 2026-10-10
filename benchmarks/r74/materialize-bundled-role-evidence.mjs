import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ModelQualificationReceiptSchema, roleQualificationStatusFor } from '@codeforge/eight-bit';

const files = [
  'docs/evidence/r71-packaged-free-supply-expansion/kilo-free-direct-cohere_north-mini-code_free-2026-10-08T12-03-32-552Z-qualification.json',
  'docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json',
  'docs/evidence/r74-autonomous-completion-and-free-reliability/planner-nvidia_nemotron-3-super-120b-a12b_free-1791629043713.json',
  'docs/evidence/r74-autonomous-completion-and-free-reliability/planner-nvidia_llama-3.2-11b-vision-1791629583054.json',
];
const entries = [];
for (const file of files) {
  const bytes = await readFile(file);
  const document = JSON.parse(bytes);
  const qualification = ModelQualificationReceiptSchema.parse(document.qualification ?? document);
  if (qualification.metadata?.transient || !Object.keys(qualification.roleResults).some(role => roleQualificationStatusFor(qualification, role) === 'QUALIFIED')) throw new Error('CURRENT_CONCLUSIVE_LIVE_ROLE_REQUIRED');
  entries.push({ source: file, sourceSha256: createHash('sha256').update(bytes).digest('hex'), qualification });
}
await writeFile('packages/model-registry/src/bundled-role-evidence.json', JSON.stringify(entries, null, 2) + '\n');
console.log(JSON.stringify({ entries: entries.length, class: 'LIVE_QUALIFICATION_ONLY_NO_AVAILABILITY_OR_AUTHORITY_GRANT' }));
