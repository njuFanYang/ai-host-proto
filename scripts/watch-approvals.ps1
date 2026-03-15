param(
  [string]$HostUrl = 'http://127.0.0.1:7788',
  [string]$SessionId,
  [ValidateSet('pending', 'resolved')]
  [string]$Status,
  [switch]$Latest,
  [switch]$Once,
  [int]$IntervalSeconds = 2,
  [switch]$Stream
)

$ErrorActionPreference = 'Stop'

function Get-Sessions {
  (Invoke-RestMethod -Method Get -Uri "$HostUrl/sessions").sessions
}

function Resolve-ApprovalSessionId {
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

  return $null
}

function Get-ApprovalRows {
  param([string]$BaseUrl, [string]$FilterSessionId, [string]$FilterStatus)

  if ($FilterSessionId) {
    $uri = "$BaseUrl/sessions/$FilterSessionId/approvals"
    return (Invoke-RestMethod -Method Get -Uri $uri).approvals
  }

  $uri = if ($FilterStatus) { "$BaseUrl/approvals?status=$FilterStatus" } else { "$BaseUrl/approvals" }
  return (Invoke-RestMethod -Method Get -Uri $uri).approvals
}

function Write-ApprovalRows {
  param($Approvals)

  Write-Output "Approvals: $($Approvals.Count)"
  Write-Output ''
  foreach ($approval in $Approvals) {
    Write-Output ("[{0}] {1} {2} {3} ({4})" -f $approval.requestId, $approval.status, $approval.riskLevel, $approval.actionType, $approval.hostSessionId)
    if ($approval.summary) {
      Write-Output ("  summary: {0}" -f $approval.summary)
    }
    if ($approval.decision) {
      Write-Output ("  decision: {0} by {1}" -f $approval.decision.decision, $approval.decision.decidedBy)
    }
  }
}

function Invoke-ApprovalStream {
  param(
    [string]$BaseUrl,
    [string]$FilterSessionId,
    [string]$FilterStatus,
    [switch]$ExitAfterSnapshot
  )

  $query = @()
  if ($FilterSessionId) {
    $query += ('hostSessionId=' + [uri]::EscapeDataString($FilterSessionId))
  }
  if ($FilterStatus) {
    $query += ('status=' + [uri]::EscapeDataString($FilterStatus))
  }
  $uri = "$BaseUrl/approvals/stream"
  if ($query.Count -gt 0) {
    $uri += ('?' + ($query -join '&'))
  }

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
              Write-ApprovalRows -Approvals @($payload.approvals)
              if ($ExitAfterSnapshot) {
                return
              }
            }
            'approval' {
              $approval = $payload.approval
              Write-Output ("[{0}] {1} {2} {3} ({4})" -f $approval.requestId, $approval.status, $approval.riskLevel, $approval.actionType, $approval.hostSessionId)
              if ($approval.summary) {
                Write-Output ("  summary: {0}" -f $approval.summary)
              }
              if ($approval.decision) {
                Write-Output ("  decision: {0} by {1}" -f $approval.decision.decision, $approval.decision.decidedBy)
              }
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

$resolvedSessionId = Resolve-ApprovalSessionId -InputId $SessionId -UseLatest:$Latest

if ($Stream) {
  Invoke-ApprovalStream -BaseUrl $HostUrl -FilterSessionId $resolvedSessionId -FilterStatus $Status -ExitAfterSnapshot:$Once
  exit 0
}

while ($true) {
  $approvals = @(Get-ApprovalRows -BaseUrl $HostUrl -FilterSessionId $resolvedSessionId -FilterStatus $Status)
  if (-not $Once) {
    Clear-Host
  }

  Write-ApprovalRows -Approvals $approvals

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $IntervalSeconds
}
