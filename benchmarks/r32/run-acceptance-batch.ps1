# R32 live acceptance batch — sequential runs over digest-locked R23/R25 tasks.
# Diversified 12-task suite: includes the R31 false-success task (ts-refactor-extract-validator),
# R31 passes (regression), R31 correct blocks/honest fails (retry under the new review budget),
# new task classes (feature, build config, review), and one controlled 429 injection.
param(
  [string]$Model = "nvidia/nemotron-3-super-120b-a12b:free",
  [string]$EvidenceDir = "docs/evidence/r32-autonomy-perfection/10-live-acceptance"
)
$ErrorActionPreference = "Continue"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
Push-Location $repo

$tasks = @(
  @{ corpus = "r23"; id = "ts-refactor-extract-validator" },
  @{ corpus = "r23"; id = "js-bug-fix-cart-total" },
  @{ corpus = "r23"; id = "ts-feature-cli-stats" },
  @{ corpus = "r23"; id = "js-feature-rate-limiter" },
  @{ corpus = "r23"; id = "js-build-config-test-script" },
  @{ corpus = "r23"; id = "py-bug-fix-config-merge" },
  @{ corpus = "r23"; id = "ts-bug-fix-queue-order" },
  @{ corpus = "r23"; id = "js-investigation-webhook-retries" },
  @{ corpus = "r23"; id = "ts-large-context-rename-config-key" },
  @{ corpus = "r25"; id = "r25-testfix-js-stale-expected" },
  @{ corpus = "r25"; id = "r25-review-ts-config-swallow" },
  @{ corpus = "r23"; id = "qual-js-missing-export"; inject429 = $true }
)

$results = @()
foreach ($t in $tasks) {
  $env:R32_LIVE_ENABLE = "true"
  $env:R32_LIVE_PROVIDER = "openrouter"
  $env:R32_LIVE_MODEL = $Model
  $env:R32_LIVE_TASK_ID = $t.id
  $env:R32_LIVE_CORPUS = $t.corpus
  $env:R32_LIVE_EVIDENCE_DIR = $EvidenceDir
  $env:R32_LIVE_MAX_OUTPUT_TOKENS = "4096"
  $env:R32_LIVE_INJECT_429_ONCE = if ($t.inject429) { "true" } else { "false" }
  $started = Get-Date
  Write-Output ("[batch] START {0}/{1} inject429={2} at {3}" -f $t.corpus, $t.id, [bool]$t.inject429, $started.ToString("HH:mm:ss"))
  node benchmarks/r32/live-workflow-completion.mjs 2>&1 | Out-String | Tee-Object -FilePath (Join-Path $EvidenceDir ("batch-{0}.log" -f $t.id)) | Out-Null
  $code = $LASTEXITCODE
  Write-Output ("[batch] DONE {0} exit={1} elapsed={2}s" -f $t.id, $code, [int]((Get-Date) - $started).TotalSeconds)
  $results += [ordered]@{ task = $t.id; corpus = $t.corpus; exitCode = $code }
}
$results | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir "batch-index.json") -Encoding utf8
Pop-Location
Write-Output "[batch] complete"
