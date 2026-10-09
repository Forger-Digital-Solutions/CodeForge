$ErrorActionPreference = 'Stop'
$r73Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$r73Modules = Join-Path $r73Root 'node_modules'
$r72Modules = 'G:\CodeForge\worktrees\r72-free-supply-and-autonomy\node_modules'
New-Item -ItemType Directory -Force $r73Modules | Out-Null
foreach ($dependencyEntry in Get-ChildItem -LiteralPath $r72Modules -Force) {
    $dependencyTarget = Join-Path $r73Modules $dependencyEntry.Name
    if ($dependencyEntry.Name -eq '@codeforge') {
        New-Item -ItemType Directory -Force $dependencyTarget | Out-Null
        foreach ($workspacePackage in Get-ChildItem -LiteralPath (Join-Path $r73Root 'packages') -Directory) {
            $workspaceTarget = Join-Path $dependencyTarget $workspacePackage.Name
            if ((Test-Path -LiteralPath (Join-Path $workspacePackage.FullName 'package.json')) -and !(Test-Path -LiteralPath $workspaceTarget)) {
                New-Item -ItemType Junction -Path $workspaceTarget -Target $workspacePackage.FullName | Out-Null
            }
        }
    } elseif (!(Test-Path -LiteralPath $dependencyTarget)) {
        if ($dependencyEntry.Name -eq '.bin') {
            Copy-Item -LiteralPath $dependencyEntry.FullName -Destination $dependencyTarget -Recurse
        } elseif ($dependencyEntry.PSIsContainer) {
            New-Item -ItemType Junction -Path $dependencyTarget -Target $dependencyEntry.FullName | Out-Null
        } else {
            Copy-Item -LiteralPath $dependencyEntry.FullName -Destination $dependencyTarget
        }
    }
}
Write-Output 'Third-party dependencies reused; workspace package links point exclusively to R73. No native rebuild or dependency installation.'
