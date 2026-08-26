import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This script runs from apps/desktop directory (npm workspace)
// node_modules is at workspace root (../node_modules)
// We need to copy to native-modules (relative to apps/desktop)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sourcePath = join(__dirname, '..', '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const destDir = join(__dirname, '..', 'native-modules', 'better-sqlite3');
const destPath = join(destDir, 'better_sqlite3.node');

if (!existsSync(sourcePath)) {
  console.error(`Native module not found at: ${sourcePath}`);
  console.error('Run "npm run rebuild:native" first');
  process.exit(1);
}

// Ensure destination directory exists
mkdirSync(destDir, { recursive: true });

copyFileSync(sourcePath, destPath);
console.log(`Copied ${sourcePath} to ${destPath}`);
