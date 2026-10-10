import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const anchor = '    try {\n        return (0, cross_spawn_1.spawn)(command, args, options);';
const nativeBranch = '    try {\n        if (process.platform === "win32" && (command.endsWith(".exe") || command.endsWith(".EXE"))) {\n            return (0, child_process_1.spawn)(command, args, options);\n        }\n        return (0, cross_spawn_1.spawn)(command, args, options);';

export function patchBuilderUtilSource(source) {
  if (source.includes(nativeBranch)) return source;
  if (source.split(anchor).length !== 2) throw new Error('Unrecognized builder-util spawn implementation; review the Windows executable patch before installation.');
  // Keep the existing Windows executable fix while avoiding patch-package's vulnerable
  // globbing dependency chain. An upstream implementation change fails explicitly.
  return source.replace(anchor, nativeBranch);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolve('node_modules/builder-util/out/util.js');
  const source = await readFile(target, 'utf8');
  const patched = patchBuilderUtilSource(source);
  if (patched !== source) await writeFile(target, patched);
  console.log(JSON.stringify({ patch: 'builder-util Windows executable spawn', changed: patched !== source }));
}
