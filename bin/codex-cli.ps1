param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

& "$PSScriptRoot\..\scripts\start-managed.ps1" cli @Args
