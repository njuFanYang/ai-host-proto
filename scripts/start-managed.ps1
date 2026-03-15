param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('cli', 'ide')]
  [string]$Target,

  [string]$HostUrl = 'http://127.0.0.1:7788',
  [string]$Cwd = (Get-Location).Path,
  [string]$Prompt = '',

  [ValidateSet('tty', 'exec-json', 'sdk', 'app-server')]
  [string]$CliMode = 'tty',

  [ValidateSet('read-only', 'workspace-write', 'danger-full-access')]
  [string]$Sandbox = 'read-only',

  [switch]$SkipGitRepoCheck,
  [switch]$OpenCode,
  [switch]$NoLaunchCode
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

function Start-ManagedIde {
  param(
    [string]$BaseUrl,
    [string]$SessionCwd,
    [bool]$ShouldOpenCode
  )

  $body = @{
    mode = 'wrapper-managed'
    cwd = $SessionCwd
  }

  $result = Invoke-HostJson -Method Post -Uri "$BaseUrl/sessions/ide" -Body $body
  $wrapperInfo = $result.wrapperLaunchInfo

  if ($ShouldOpenCode) {
    $codePath = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source
    if (-not $codePath) {
      $codePath = (Get-Command code -ErrorAction SilentlyContinue).Source
    }

    if (-not $codePath) {
      throw 'VS Code command not found. Install `code` on PATH or rerun with -NoLaunchCode.'
    }

    $cmd = "set AI_HOST_URL=$($wrapperInfo.hostUrl)&& set AI_HOST_SESSION_ID=$($result.session.hostSessionId)&& `"$codePath`" `"$SessionCwd`""
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd | Out-Null
  }

  [pscustomobject]@{
    target = 'ide'
    hostSessionId = $result.session.hostSessionId
    transport = $result.session.transport
    registrationState = $result.session.registrationState
    status = $result.session.status
    workspaceRoot = $result.session.workspaceRoot
    wrapperPath = $wrapperInfo.wrapperPath
    hostUrl = $wrapperInfo.hostUrl
    launchedCode = $ShouldOpenCode
    note = 'Set VS Code ChatGPT/Codex cliExecutable to the wrapperPath if you want the extension to route through the host.'
    env = $wrapperInfo.env
  }
}

if (-not (Test-HostReady -BaseUrl $HostUrl)) {
  throw "Host is not reachable at $HostUrl. Start it first with: node src/server.js"
}

if ($Target -eq 'cli') {
  $result = Start-ManagedCli -BaseUrl $HostUrl -SessionCwd $Cwd -SessionPrompt $Prompt -Mode $CliMode -SandboxMode $Sandbox -SkipRepoCheck $SkipGitRepoCheck.IsPresent
  $result | ConvertTo-Json -Depth 8
  exit 0
}

$shouldOpenCode = $OpenCode.IsPresent
if (-not $NoLaunchCode.IsPresent -and -not $OpenCode.IsPresent) {
  $shouldOpenCode = $true
}

$result = Start-ManagedIde -BaseUrl $HostUrl -SessionCwd $Cwd -ShouldOpenCode $shouldOpenCode
$result | ConvertTo-Json -Depth 8
exit 0
