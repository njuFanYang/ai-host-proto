param(
  [switch]$UserPath,
  [switch]$SessionOnly
)

$ErrorActionPreference = 'Stop'
$binPath = (Resolve-Path (Join-Path $PSScriptRoot '..\bin')).Path

if ($SessionOnly) {
  if ($env:PATH -notlike "*$binPath*") {
    $env:PATH = "$binPath;$env:PATH"
  }
  Write-Output "Added to current session PATH: $binPath"
  return
}

if ($UserPath -or -not $SessionOnly) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($current) {
    $parts = $current -split ';' | Where-Object { $_ }
  }

  if ($parts -contains $binPath) {
    Write-Output "User PATH already contains: $binPath"
    return
  }

  $next = if ($current) { "$binPath;$current" } else { $binPath }
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Write-Output "Added to user PATH: $binPath"
  Write-Output 'Restart PowerShell/cmd to use codex-cli directly.'
}
