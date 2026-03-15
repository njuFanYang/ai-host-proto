param(
  [string]$HostUrl = 'http://127.0.0.1:7788',
  [string]$SessionId,
  [ValidateSet('pending', 'resolved')]
  [string]$Status,
  [switch]$Latest,
  [switch]$Once,
  [int]$IntervalSeconds = 2
)

$ErrorActionPreference = 'Stop'

function Get-ApprovalRows {
  param([string]$BaseUrl, [string]$FilterSessionId, [string]$FilterStatus)

  if ($FilterSessionId) {
    $uri = "$BaseUrl/sessions/$FilterSessionId/approvals"
    return (Invoke-RestMethod -Method Get -Uri $uri).approvals
  }

  $uri = if ($FilterStatus) { "$BaseUrl/approvals?status=$FilterStatus" } else { "$BaseUrl/approvals" }
  return (Invoke-RestMethod -Method Get -Uri $uri).approvals
}

while ($true) {
  $approvals = @(Get-ApprovalRows -BaseUrl $HostUrl -FilterSessionId $SessionId -FilterStatus $Status)
  if (-not $Once) {
    Clear-Host
  }

  Write-Output "Approvals: $($approvals.Count)"
  Write-Output ''
  foreach ($approval in $approvals) {
    Write-Output ("[{0}] {1} {2} {3} ({4})" -f $approval.requestId, $approval.status, $approval.riskLevel, $approval.actionType, $approval.hostSessionId)
    if ($approval.summary) {
      Write-Output ("  summary: {0}" -f $approval.summary)
    }
    if ($approval.decision) {
      Write-Output ("  decision: {0} by {1}" -f $approval.decision.decision, $approval.decision.decidedBy)
    }
  }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $IntervalSeconds
}
