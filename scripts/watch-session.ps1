param(
  [string]$SessionId,
  [string]$HostUrl = 'http://127.0.0.1:7788',
  [int]$IntervalSeconds = 2,
  [int]$Tail = 20,
  [switch]$Latest,
  [switch]$Once,
  [switch]$Stream
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

function Format-Capabilities {
  param($Capabilities)

  if (-not $Capabilities) {
    return 'n/a'
  }

  return (
    "register={0} output={1} inject={2} hitl={3}" -f
      $Capabilities.sessionRegistration,
      $Capabilities.outputCollection,
      $Capabilities.messageInjection,
      $Capabilities.autoHitl
  )
}

function Format-EventLine {
  param($Event)

  $summary = switch ($Event.kind) {
    'assistant_output' { $Event.payload.text }
    'assistant_output_delta' { $Event.payload.delta }
    'user_input' { $Event.payload.text }
    'stderr' { $Event.payload.line }
    'approval_request' { "$($Event.payload.riskLevel) $($Event.payload.actionType) $($Event.payload.summary)" }
    'approval_result' { "$($Event.payload.decision) by $($Event.payload.decidedBy)" }
    'session_started' { ($Event.payload | ConvertTo-Json -Compress -Depth 5) }
    'session_ended' { ($Event.payload | ConvertTo-Json -Compress -Depth 5) }
    'wrapper_runtime_reported' { "pid=$($Event.payload.processId) realCodex=$($Event.payload.realCodex)" }
    default { ($Event.payload | ConvertTo-Json -Compress -Depth 5) }
  }

  "[$($Event.timestamp)] [$($Event.kind)] [$($Event.controllability)] $summary"
}

function Write-SessionSummary {
  param($Session)

  Write-Output "Session:      $($Session.hostSessionId)"
  Write-Output "Source:       $($Session.source)"
  Write-Output "Transport:    $($Session.transport)"
  Write-Output "Mode:         $($Session.runtime.mode)"
  Write-Output "Status:       $($Session.status)"
  Write-Output "Registration: $($Session.registrationState)"
  Write-Output "Upstream:     $($Session.upstreamSessionId)"
  Write-Output "Workspace:    $($Session.workspaceRoot)"
  Write-Output "Capabilities: $(Format-Capabilities -Capabilities $Session.transportCapabilities)"
  if ($Session.runtime.processId) {
    Write-Output "ProcessId:    $($Session.runtime.processId)"
  }
  if ($Session.runtime.realCodex) {
    Write-Output "Real Codex:   $($Session.runtime.realCodex)"
  }
  if ($Session.runtime.proxyMode) {
    Write-Output "Proxy Mode:   $($Session.runtime.proxyMode)"
  }
  if ($Session.runtime.launchedAt) {
    Write-Output "Launched At:  $($Session.runtime.launchedAt)"
  }
}

function Invoke-SessionStream {
  param(
    [string]$BaseUrl,
    [string]$ResolvedSessionId,
    [int]$RecentTail,
    [switch]$ExitAfterSnapshot
  )

  $uri = "$BaseUrl/sessions/$ResolvedSessionId/events/stream"
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  try {
    $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get, $uri)
    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = New-Object System.IO.StreamReader($stream)
    $eventName = $null
    $dataLines = New-Object 'System.Collections.Generic.List[string]'

    while (($line = $reader.ReadLine()) -ne $null) {
      if ($line.StartsWith(':')) {
        continue
      }

      if ($line -eq '') {
        if ($eventName -and $dataLines.Count -gt 0) {
          $payload = ($dataLines -join "`n") | ConvertFrom-Json
          switch ($eventName) {
            'snapshot' {
              Write-SessionSummary -Session $payload.session
              Write-Output ''
              Write-Output 'Recent events:'
              @($payload.events | Select-Object -Last $RecentTail) | ForEach-Object {
                Write-Output (Format-EventLine -Event $_)
              }
              if ($ExitAfterSnapshot) {
                return
              }
            }
            'session' {
              Write-Output ("[session] status={0} registration={1} upstream={2}" -f $payload.session.status, $payload.session.registrationState, $payload.session.upstreamSessionId)
            }
            'event' {
              Write-Output (Format-EventLine -Event $payload.event)
            }
            'approval' {
              Write-Output ("[approval] [{0}] {1} {2} {3}" -f $payload.approval.requestId, $payload.action, $payload.approval.riskLevel, $payload.approval.summary)
            }
          }
        }

        $eventName = $null
        $dataLines.Clear()
        continue
      }

      if ($line.StartsWith('event: ')) {
        $eventName = $line.Substring(7)
        continue
      }

      if ($line.StartsWith('data: ')) {
        [void]$dataLines.Add($line.Substring(6))
      }
    }
  }
  finally {
    if ($client) {
      $client.Dispose()
    }
  }
}

$resolvedSessionId = Resolve-SessionId -InputId $SessionId -UseLatest:$Latest

if ($Stream) {
  Invoke-SessionStream -BaseUrl $HostUrl -ResolvedSessionId $resolvedSessionId -RecentTail $Tail -ExitAfterSnapshot:$Once
  exit 0
}

while ($true) {
  $session = (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions/$resolvedSessionId").session
  $events = (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions/$resolvedSessionId/events").events

  if (-not $Once) {
    Clear-Host
  }
  Write-SessionSummary -Session $session
  Write-Output ''
  Write-Output 'Recent events:'

  $recent = @($events | Select-Object -Last $Tail)
  foreach ($event in $recent) {
    Write-Output (Format-EventLine -Event $event)
  }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $IntervalSeconds
}
