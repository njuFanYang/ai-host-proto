param(
  [string]$SessionId,
  [string]$HostUrl = 'http://127.0.0.1:7788',
  [int]$IntervalSeconds = 2,
  [int]$Tail = 20,
  [switch]$Latest,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'

function Get-Sessions {
  (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions").sessions
}

function Resolve-SessionId {
  param([string]$InputId, [switch]$UseLatest)

  if ($InputId) {
    return $InputId
  }

  if ($UseLatest) {
    $sessions = Get-Sessions
    if (-not $sessions -or $sessions.Count -eq 0) {
      throw 'No managed sessions found.'
    }
    return $sessions[0].hostSessionId
  }

  throw 'Provide -SessionId or -Latest.'
}

function Format-EventLine {
  param($Event)

  $summary = switch ($Event.kind) {
    'assistant_output' { $Event.payload.text }
    'user_input' { $Event.payload.text }
    'stderr' { $Event.payload.line }
    'approval_request' { "$($Event.payload.riskLevel) $($Event.payload.actionType) $($Event.payload.summary)" }
    'approval_result' { "$($Event.payload.decision) by $($Event.payload.decidedBy)" }
    default { ($Event.payload | ConvertTo-Json -Compress -Depth 5) }
  }

  "[$($Event.timestamp)] [$($Event.kind)] $summary"
}

$resolvedSessionId = Resolve-SessionId -InputId $SessionId -UseLatest:$Latest
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

while ($true) {
  $session = (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions/$resolvedSessionId").session
  $events = (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions/$resolvedSessionId/events").events

  if (-not $Once) {
    Clear-Host
  }
  Write-Output "Session: $($session.hostSessionId)"
  Write-Output "Source:  $($session.source)"
  Write-Output "Transport: $($session.transport)"
  Write-Output "Status: $($session.status)"
  Write-Output "Registration: $($session.registrationState)"
  Write-Output "Workspace: $($session.workspaceRoot)"
  if ($session.runtime.processId) {
    Write-Output "TTY PID: $($session.runtime.processId)"
  }
  Write-Output ""
  Write-Output "Recent events:"

  $recent = @($events | Select-Object -Last $Tail)
  foreach ($event in $recent) {
    [void]$seen.Add($event.eventId)
    Write-Output (Format-EventLine -Event $event)
  }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $IntervalSeconds
}
