import { mkdirSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const source = 'G:/CodeForge/node_modules';
const destination = path.resolve('node_modules');
mkdirSync(destination, { recursive: true });
for (const item of readdirSync(source, { withFileTypes: true })) {
  if (!item.isDirectory() || ['@codeforge', '.vite', '.cache'].includes(item.name)) continue;
  const target = path.join(destination, item.name);
  if (!existsSync(target)) symlinkSync(path.join(source, item.name), target, 'junction');
}
mkdirSync(path.join(destination, '@codeforge'), { recursive: true });
for (const item of readdirSync('packages', { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  const target = path.join(destination, '@codeforge', item.name);
  if (!existsSync(target)) symlinkSync(path.resolve('packages', item.name), target, 'junction');
}
console.log('Linked isolated workspace packages and existing third-party dependencies.');
