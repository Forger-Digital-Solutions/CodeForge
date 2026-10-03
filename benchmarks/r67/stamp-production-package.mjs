import { readFile, writeFile } from 'node:fs/promises';
import { createReleaseManifest } from '../../apps/desktop/scripts/package-release.mjs';
const manifest = JSON.parse(await readFile('apps/desktop/cloud-endpoints.json', 'utf8'));
const production = createReleaseManifest(manifest, 'production');
await writeFile('apps/desktop/dist/cloud-endpoints.json', `${JSON.stringify(production, null, 2)}\n`);
console.log(JSON.stringify({ channel: production.channel, endpoint: production.endpoints.production, trackedManifestModified: false }));
