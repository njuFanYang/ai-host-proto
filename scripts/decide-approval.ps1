param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$RequestId,
  [ValidateSet('approve', 'deny', 'escalate')]
  [string]$Decision = 'approve',
  [string]$Reason = '',
  [string]$HostUrl = 'http://127.0.0.1:7788'
)

$ErrorActionPreference = 'Stop'

$body = @{
  decision = $Decision
  decidedBy = 'human'
  reason = $Reason
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post -Uri "$HostUrl/approvals/$RequestId/decision" -ContentType 'application/json' -Body $body
$result | ConvertTo-Json -Depth 8
