import assert from 'node:assert/strict';
import { execute, backendFor } from '@codeforge/terminal';
assert.equal(backendFor(), 'conpty');
for (let round = 0; round < 4; round++) {
  await Promise.all([0, 7, 0, 7].map(async (code, index) => {
    const marker = `round-${round}-command-${index}`;
    const result = await execute({ file: process.execPath,
      args: ['-e', `process.stdout.write('${marker}\\n' + 'x'.repeat(131072)); process.exit(${code})`],
      timeoutMs: 20000 });
    assert.equal(result.exitCode, code);
    assert.equal(result.backend, 'conpty');
    assert(result.output.includes(marker));
    assert(result.output.includes('x'.repeat(1024)));
  }));
}
await new Promise(resolve => setTimeout(resolve, 1500));
console.log('CONPTY_CLOSE_STRESS_PASS');
