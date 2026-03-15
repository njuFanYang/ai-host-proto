param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

& "$PSScriptRoot\..\scripts\watch-session.ps1" @Args
