param(
  [string]$ReleaseRoot = "apps/desktop/release",
  [string]$OutputPath = "docs/evidence/r31-production-release-closure/12-signing/readiness.json",
  [string]$Version = "",
  [switch]$RequireSigned,
  [switch]$ExerciseUnsignedNegativeGate
)

$ErrorActionPreference = "Stop"
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
function FullPath([string]$value) {
  if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value) }
  return [IO.Path]::GetFullPath((Join-Path $repositoryRoot $value))
}
$release = FullPath $ReleaseRoot
$output = FullPath $OutputPath
$outputDirectory = Split-Path -Parent $output
if (-not $outputDirectory.StartsWith($repositoryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) {
  throw "Signing evidence output must remain inside the repository."
}
if (-not $Version) {
  $Version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "apps/desktop/package.json") -Raw | ConvertFrom-Json).version
}
$files = [ordered]@{
  unpackedExecutable = Join-Path $release "win-unpacked/CodeForge.exe"
  installer = Join-Path $release "CodeForge-Setup-$Version.exe"
  portableExecutable = Join-Path $release "CodeForge-Portable.exe"
}
$artifacts = @(
  foreach ($kind in $files.Keys) {
    $file = $files[$kind]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      [ordered]@{ kind = $kind; path = $file; exists = $false; sha256 = $null; signatureStatus = "Missing"; signerThumbprint = $null; timestamped = $false; timestampThumbprint = $null }
      continue
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    [ordered]@{
      kind = $kind
      path = $file
      exists = $true
      bytes = (Get-Item -LiteralPath $file).Length
      sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
      signatureStatus = [string]$signature.Status
      signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
      signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
      timestamped = $null -ne $signature.TimeStamperCertificate
      timestampThumbprint = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Thumbprint } else { $null }
    }
  }
)
$codeSigningCerts = @(Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
  Where-Object { $_.EnhancedKeyUsageList.FriendlyName -contains "Code Signing" })
$allSigned = @($artifacts | Where-Object {
  $_.signatureStatus -ne "Valid" -or -not $_.signerThumbprint -or -not $_.timestamped
}).Count -eq 0
$receipt = [ordered]@{
  schema = "codeforge-r31-signing-readiness-1"
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceHead = (& git -C $repositoryRoot rev-parse HEAD).Trim()
  version = $Version
  availableCodeSigningIdentityCount = $codeSigningCerts.Count
  signingEnvironmentConfigured = [ordered]@{
    WIN_CSC_LINK = -not [string]::IsNullOrWhiteSpace($env:WIN_CSC_LINK)
    WIN_CSC_KEY_PASSWORD = -not [string]::IsNullOrWhiteSpace($env:WIN_CSC_KEY_PASSWORD)
  }
  artifacts = $artifacts
  allArtifactsTrustedAndTimestamped = $allSigned
  unsignedNegativeGate = $null
  result = if ($allSigned) { "PASS" } else { "SIGNING_PENDING" }
  interpretation = if ($allSigned) {
    "All three local release executables have a valid Authenticode signature and timestamp."
  } else {
    "At least one local release executable is missing, unsigned, untrusted, or lacks a timestamp. A production signing identity and successful tagged-build path remain unproven."
  }
}
if ($ExerciseUnsignedNegativeGate) {
  if (@($artifacts | Where-Object { $_.signatureStatus -ne "NotSigned" }).Count -gt 0) {
    $receipt.unsignedNegativeGate = [ordered]@{ attempted = $false; reason = "current artifacts are not all unsigned" }
  } else {
    $verifier = Join-Path $repositoryRoot "scripts/verify-windows-signatures.ps1"
    $null = & pwsh -NoProfile -File $verifier -ReleaseRoot $release -Version $Version 2>&1
    $gateExitCode = $LASTEXITCODE
    $receipt.unsignedNegativeGate = [ordered]@{ attempted = $true; verifierExitCode = $gateExitCode; rejectedUnsignedArtifacts = $gateExitCode -ne 0 }
    if ($gateExitCode -eq 0) { $receipt.result = "FAIL_UNSIGNED_GATE_ACCEPTED" }
  }
}
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding utf8
Write-Output ("R31 signing readiness: " + $receipt.result)
Write-Output "Receipt: $output"
if ($receipt.result -eq "FAIL_UNSIGNED_GATE_ACCEPTED" -or ($RequireSigned -and -not $allSigned)) {
  throw "R31 signing gate did not pass; inspect $output"
}
