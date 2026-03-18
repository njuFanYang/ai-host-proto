param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('cli')]
  [string]$Target,

  [string]$HostUrl = 'http://127.0.0.1:7788',
  [string]$Cwd = (Get-Location).Path,
  [string]$Prompt = '',

  [ValidateSet('tty', 'exec-json', 'sdk', 'app-server')]
  [string]$CliMode = 'tty',

  [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
  [string]$Sandbox = 'read-only',

  [switch]$SkipGitRepoCheck
)

$ErrorActionPreference = 'Stop'

function Invoke-HostJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [object]$Body = $null
  )

  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri
  }

  return Invoke-RestMethod -Method $Method -Uri $Uri -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 8)
}

function Test-HostReady {
  param([string]$BaseUrl)
  try {
    Invoke-RestMethod -Method Get -Uri "$BaseUrl/health" | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Start-ManagedCli {
  param(
    [string]$BaseUrl,
    [string]$SessionCwd,
    [string]$SessionPrompt,
    [string]$Mode,
    [string]$SandboxMode,
    [bool]$SkipRepoCheck
  )

  $body = @{
    mode = $Mode
    cwd = $SessionCwd
  }

  if ($SessionPrompt) {
    $body.prompt = $SessionPrompt
  }

  if ($Mode -ne 'tty') {
    $body.sandbox = $SandboxMode
  }

  if ($Mode -eq 'exec-json') {
    $body.skipGitRepoCheck = $SkipRepoCheck
  }

  $result = Invoke-HostJson -Method Post -Uri "$BaseUrl/sessions/cli" -Body $body
  [pscustomobject]@{
    target = 'cli'
    hostSessionId = $result.session.hostSessionId
    transport = $result.session.transport
    registrationState = $result.session.registrationState
    status = $result.session.status
    workspaceRoot = $result.session.workspaceRoot
    terminalLaunchInfo = $result.terminalLaunchInfo
    next = if ($Mode -eq 'tty') {
      @('A managed tty Codex window should open separately.')
    } else {
      @(
        "Invoke-RestMethod $BaseUrl/sessions/$($result.session.hostSessionId)",
        "Invoke-RestMethod $BaseUrl/sessions/$($result.session.hostSessionId)/events"
      )
    }
  }
}

if (-not (Test-HostReady -BaseUrl $HostUrl)) {
  throw "Host is not reachable at $HostUrl. Start it first with: node src/server.js"
}

$result = Start-ManagedCli -BaseUrl $HostUrl -SessionCwd $Cwd -SessionPrompt $Prompt -Mode $CliMode -SandboxMode $Sandbox -SkipRepoCheck $SkipGitRepoCheck.IsPresent
$result | ConvertTo-Json -Depth 8
exit 0
