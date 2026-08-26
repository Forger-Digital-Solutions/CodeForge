import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const sourcePath = join(process.cwd(), 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const destDir = join(process.cwd(), 'native-modules', 'better-sqlite3');
const destPath = join(destDir, 'better_sqlite3.node');

if (!existsSync(sourcePath)) {
  console.error(`Native module not found at: ${sourcePath}`);
  console.error('Run "npm run rebuild:native" first');
  process.exit(1);
}

// Ensure destination directory exists
import { mkdirSync } from 'node:fs';
mkdirSync(destDir, { recursive: true });

copyFileSync(sourcePath, destPath);
console.log(`Copied ${sourcePath} to ${destPath}`);
