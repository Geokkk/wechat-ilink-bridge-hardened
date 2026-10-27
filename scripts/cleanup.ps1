<# 
.SYNOPSIS
    wxb cleanup - Periodic maintenance script for WeChat iLink Bridge

.DESCRIPTION
    This script runs `wxb cleanup` with default retention settings:
      - Message retention: 30 days (WX_MESSAGE_RETENTION_DAYS)
      - Attachment retention: 30 days (WX_ATTACHMENT_RETENTION_DAYS)
      - Max history messages: 10000 (WX_MAX_HISTORY_MESSAGES)

    These match the upstream defaults. Override via environment variables if needed.

.SCHEDULING
    Windows Task Scheduler:
      1. Open Task Scheduler (taskschd.msc)
      2. Create Basic Task -> Name: "wxb cleanup"
      3. Trigger: Daily at 3:00 AM (or preferred time)
      4. Action: Start a Program
         - Program: powershell.exe
         - Arguments: -ExecutionPolicy Bypass -File "C:\path\to\cleanup.ps1"
      5. Finish

    Or use schtasks command line:
      schtasks /create /tn "wxb cleanup" /tr "powershell.exe -ExecutionPolicy Bypass -File C:\path\to\cleanup.ps1" /sc daily /st 03:00

.SECURITY
    IMPORTANT: The state directory contains credentials (bot tokens, context tokens).
    Do NOT back up the state directory to any git repository or shared location.
    If you need backups, encrypt them and store securely.
#>

[CmdletBinding()]
param(
    [Parameter()]
    [string]$StateDir = "$env:LOCALAPPDATA\wxb",

    [Parameter()]
    [int]$MessageRetentionDays = 30,

    [Parameter()]
    [int]$AttachmentRetentionDays = 30,

    [Parameter()]
    [int]$MaxHistoryMessages = 10000
)

# Resolve script directory to find wxb if installed locally
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir

# Use local wxb if available, otherwise assume wxb is in PATH
if (Test-Path "$ProjectRoot\src\cli\index.js") {
    $WxbCmd = "node", "$ProjectRoot\src\cli\index.js"
} else {
    $WxbCmd = "wxb"
}

Write-Host "[$(Get-Date)] Starting wxb cleanup..."
Write-Host "State directory: $StateDir"

# Build arguments
$Args = @(
    "cleanup"
    "--state-dir", $StateDir
    "--message-retention-days", $MessageRetentionDays
    "--attachment-retention-days", $AttachmentRetentionDays
    "--max-history-messages", $MaxHistoryMessages
    "--json"
)

# Run cleanup
$ExitCode = 0
try {
    & $WxbCmd @Args
    $ExitCode = $LASTEXITCODE
} catch {
    Write-Error "Cleanup failed: $_"
    $ExitCode = 1
}

if ($ExitCode -eq 0) {
    Write-Host "[$(Get-Date)] Cleanup completed successfully"
} else {
    Write-Error "[$(Get-Date)] Cleanup failed with exit code $ExitCode"
    exit $ExitCode
}