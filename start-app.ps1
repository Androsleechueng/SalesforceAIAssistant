$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Starting Salesforce AI Assistant at http://localhost:3000"
Write-Host "Leave this window open while using the app."
node --use-system-ca server.js
