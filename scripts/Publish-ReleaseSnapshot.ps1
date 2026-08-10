[CmdletBinding()]
param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [string]$ReleaseMessage
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

$dirty = (& git -C $repoRoot status --porcelain)
Assert-LastGitCommand 'checking the worktree'
if ($dirty) {
  throw 'Release snapshot requires a clean worktree. Commit or stash changes first.'
}

& git -C $repoRoot remote get-url $Remote | Out-Null
Assert-LastGitCommand "checking remote $Remote"

if (-not $ReleaseMessage) {
  $manifestPath = Join-Path $repoRoot 'manifest.json'
  $manifest = Get-Content -Raw -Encoding utf8 $manifestPath | ConvertFrom-Json
  $displayName = if ($manifest.display_name) { [string]$manifest.display_name } else { 'SillyTavern extension' }
  $version = if ($manifest.version) { " v$($manifest.version)" } else { '' }
  $ReleaseMessage = "Release: $displayName$version"
}

& git -C $repoRoot fetch $Remote "+refs/heads/$Branch`:refs/remotes/$Remote/$Branch"
Assert-LastGitCommand "fetching $Remote/$Branch"

$tree = (& git -C $repoRoot rev-parse 'HEAD^{tree}').Trim()
Assert-LastGitCommand 'reading the current source tree'

$releaseCommit = (& git -C $repoRoot commit-tree $tree -m $ReleaseMessage).Trim()
Assert-LastGitCommand 'creating the root release commit'

& git -C $repoRoot update-ref refs/heads/release-snapshot $releaseCommit
Assert-LastGitCommand 'updating release-snapshot'

& git -C $repoRoot push "--force-with-lease=refs/heads/$Branch" $Remote "refs/heads/release-snapshot:refs/heads/$Branch"
Assert-LastGitCommand "publishing $Remote/$Branch"

Write-Output "Published root snapshot $releaseCommit to $Remote/$Branch. Local development history was not changed."
