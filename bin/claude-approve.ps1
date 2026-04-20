param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

& "$PSScriptRoot\..\scripts\decide-approval.ps1" @Args
