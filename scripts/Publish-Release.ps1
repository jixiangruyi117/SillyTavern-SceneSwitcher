[CmdletBinding()]
param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-LastGitCommand([string]$Action) {
  if ($LASTEXITCODE -ne 0) {
    throw "Git failed while $Action."
  }
}

& git -C $repoRoot rev-parse --is-inside-work-tree | Out-Null
Assert-LastGitCommand 'checking the repository'

$currentBranch = (& git -C $repoRoot branch --show-current).Trim()
Assert-LastGitCommand 'reading the current branch'
if ($currentBranch -ne $Branch) {
  throw "Release must be published from $Branch, but the current branch is $currentBranch."
}

$dirty = (& git -C $repoRoot status --porcelain)
Assert-LastGitCommand 'checking the worktree'
if ($dirty) {
  throw 'Release requires a clean worktree. Commit or stash changes first.'
}

& git -C $repoRoot remote get-url $Remote | Out-Null
Assert-LastGitCommand "checking remote $Remote"

& git -C $repoRoot fetch $Remote "+refs/heads/$Branch`:refs/remotes/$Remote/$Branch"
Assert-LastGitCommand "fetching $Remote/$Branch"

& git -C $repoRoot merge-base --is-ancestor "$Remote/$Branch" HEAD
if ($LASTEXITCODE -ne 0) {
  throw "$Remote/$Branch is not an ancestor of local $Branch. Refusing a non-fast-forward release so SillyTavern native updates remain usable."
}

& git -C $repoRoot push --set-upstream $Remote "HEAD:refs/heads/$Branch"
Assert-LastGitCommand "publishing $Remote/$Branch"

$manifestPath = Join-Path $repoRoot 'manifest.json'
$manifest = Get-Content -Raw -Encoding utf8 $manifestPath | ConvertFrom-Json
$version = if ($manifest.version) { " v$($manifest.version)" } else { '' }
Write-Output "Published normal fast-forward release$version to $Remote/$Branch."
