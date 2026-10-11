import { readFile, writeFile } from 'node:fs/promises';
import { summarizeCampaign } from './campaign-metrics.mjs';

const source = process.argv[2];
if (!source) throw new Error('Supply a preserved campaign JSON path');
const summary = summarizeCampaign(JSON.parse(await readFile(source, 'utf8')));
await writeFile(`${source.replace(/\.json$/, '')}-metrics.json`, JSON.stringify({ source, ...summary }, null, 2));
console.log(JSON.stringify(summary));
