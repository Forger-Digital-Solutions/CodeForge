param(
  [string]$ReleaseRoot = "apps/desktop/release",
  [string]$Version = "0.4.0"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$paths = @(
  (Join-Path $root "win-unpacked/CodeForge.exe"),
  (Join-Path $root "CodeForge-Portable.exe"),
  (Join-Path $root "CodeForge-Setup-$Version.exe")
)
$results = foreach ($artifact in $paths) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Signing verification failed: missing artifact $artifact"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  [pscustomobject]@{
    Path = $artifact
    Status = [string]$signature.Status
    SignerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    Timestamped = $null -ne $signature.TimeStamperCertificate
  }
}
$results | ConvertTo-Json -Depth 4
if (@($results | Where-Object { $_.Status -ne "Valid" -or -not $_.SignerThumbprint -or -not $_.Timestamped }).Count -gt 0) {
  throw "Signing verification failed: every Windows executable must have a valid trusted Authenticode signature and timestamp."
}
