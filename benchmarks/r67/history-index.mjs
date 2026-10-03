import { readdir, readFile, writeFile } from 'node:fs/promises';
import { directory, read } from './release-artifacts.mjs';
const current = new Set(['R67-CANONICAL-CERTIFICATION-CAMPAIGN.json', 'R67-MULTI-USER-CERTIFICATION.json']);
const campaigns = [];
for (const file of await readdir(directory)) {
  if (!/\.json$/.test(file)) continue;
  const document = JSON.parse(await readFile(`${directory}/${file}`, 'utf8'));
  if (!Array.isArray(document.tasks)) continue;
  let longest = 0, streak = 0;
  const tasks = document.tasks.map(task => {
    streak = task.status === 'completed' ? streak + 1 : 0; longest = Math.max(longest, streak);
    return { id: task.id, taskClass: task.taskClass, status: task.status, wallTimeMs: task.wallTimeMs,
      testsBeforeExitCode: task.testsBefore?.exitCode, testsAfterExitCode: task.testsAfter?.exitCode,
      invalidWorkingBaseline: ['refactor', 'test creation'].includes(task.taskClass) && task.testsBefore?.exitCode !== undefined && task.testsBefore.exitCode !== 0,
      reason: task.error ?? task.result?.summary };
  });
  campaigns.push({ file, role: current.has(file) ? 'FINAL_CANONICAL' : 'HISTORICAL',
    recordedStatus: document.status, measuredProfileExperiment: document.measuredProfileExperiment ?? null,
    startedAt: document.startedAt, finishedAt: document.finishedAt,
    attempted: tasks.length, completed: tasks.filter(task => task.status === 'completed').length,
    longestCompletionStreak: longest, tasks });
}
const interruptedSuites = [];
for (const file of await readdir(directory)) {
  if (!/^R67-REPOSITORY-TESTS-before-.*\.json$/.test(file)) continue;
  const document = JSON.parse(await readFile(`${directory}/${file}`, 'utf8'));
  interruptedSuites.push({ file, recordedStatus: document.status, disposition: document.finishedAt ? 'COMPLETED_FAILED_SUPERSEDED_SOURCE' : 'INTERRUPTED_SUPERSEDED_SOURCE',
    reason: document.finishedAt ? 'The completed runner exited with ConPTY EPIPE despite passing assertions; the large-repository latency test also missed its unchanged threshold. Both remain historical failures.' : file.includes('watchdog') ? 'Owned runner stopped after a watchdog test assumed cold preparation had finished within three seconds. The test now synchronizes on three earned extensions; partial passes remain insufficient for repository-wide PASS.' : 'Owned runner stopped when a live gate exposed the named product defect; partial file passes do not establish a repository-wide PASS.',
    completedPhases: document.phases?.filter(phase => phase.status === 'PASS').map(phase => phase.name) ?? [],
    lastProgress: document.phases?.at(-1)?.latestProgress });
}
const result = { at: new Date().toISOString(), historicalOutputsRewritten: false, campaigns, interruptedSuites,
  corrections: [
    'The first final Explorer audit conflated an earlier cap repair with a terminal output-cap failure. CSV ultimately returned complete JSON rejected for line=0; it remains an invalid schema result, not a valid Explorer completion. The audit now separately records cap repairs, final JSON completeness and schema rejections. Role validation and completion authority are unchanged.',
    'The useful-Coder watchdog test cancelled after a fixed three seconds while cold preparation could still be active, leaving no earned-extension counter. It failed both in the main run and a separate runner. The test now waits for three durable earned extensions and then verifies active execution and cancellation, strengthening the original two-extension assertion without changing any runtime deadline.',
    'A completed repository-wide run had passing main assertions but exit code 1 from an unhandled ConPTY reader EPIPE. It is FAIL. Teardown now terminates the reader before explicitly closing its destination socket; an actual reader-worker lifecycle regression fails on the original code and passes after the fix.',
    'The first reader-worker assertion treated natural peer disconnection during worker termination as premature parent teardown and failed once. The corrected invariant observes explicit parent socket destruction after worker termination. Repeated corrected tests and the actual baseline/fixed lifecycle comparison are retained; the initial diagnostic was reported in the execution transcript.',
    'The original CSV implementation had a literal newline in a regex and refactor test had a wrongly escaped regex. Historical outputs remain; the corrected fixtures are validated in the final campaigns.',
    'New-file-only changes were missing from the review/completion diff before intent-to-add. R67-NEW-FILE-REGRESSIONS-final.json and canonical test creation prove the fix.',
    'Compound Node evaluation was incorrectly treated as one JavaScript argument and cmd stripped a quoted executable path. The final canonical campaign follows both Windows execution fixes.',
    'A CSV escaped newline followed by c was falsely matched as nc; successful tool calls did not reset malformed streaks. The final six-class and concurrent campaigns follow both fixes.',
    'The audit originally expected the shared ledger to be empty at each concurrent task finish, while other tasks were still running. The corrected audit asserts zero at campaign end; intermediate reservations are retained.',
    'An audit-only Git excludesFile=NUL failed on Windows; an empty owned ignore file replaced it. Runtime source was unchanged.',
    'Source-identity canaries timed out with one Git process per file. Batched Git hashing preserves existing IDs/filter semantics and passed nine unchanged-threshold canaries.',
    'Earlier campaign supply rows incorrectly printed the fallback qualification filename when a fresh receipt was loaded. Qualification timestamps and role statuses identify the actual fresh failed Horde receipt; the runtime used its failure. The helper now records the resolved filename.',
    'Earlier recovery helper did not prefer the fresh failed Horde receipt. The final server and Reviewer process recovery runs use the corrected helper and current eligible Kilo supply.',
    'The first recovery assertion incorrectly required one total write. Recorded source mutation replay is the invariant; distinct temporary validation writes are allowed.',
  ] };
await writeFile(`${directory}/R67-HISTORY-INDEX.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ campaigns: campaigns.length, interruptedSuites: interruptedSuites.length, preservedHistory: true }));
