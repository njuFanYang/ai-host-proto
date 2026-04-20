param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

& "$PSScriptRoot\..\scripts\watch-approvals.ps1" @Args
