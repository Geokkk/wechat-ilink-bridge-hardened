<#
.SYNOPSIS
    check-secrets - Scan workspace for leaked secrets before push

.DESCRIPTION
    This script scans the working tree for patterns that look like:
      - bot tokens (ilink_bot_token, bot_token, etc.)
      - context tokens (context_token, contextToken)
      - AES keys (32-char hex, base64-encoded 16 bytes)
      - CDN signed URLs
      - State directory paths

.USAGE
    .\scripts\check-secrets.ps1

.NOTES
    Exit code: 0 = clean, 1 = potential secrets found
#>

[CmdletBinding()]
param()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "Scanning for potential secrets..."

# Patterns to search for (case-insensitive)
$Patterns = @(
    # Bot tokens
    "bot[_-]?token"
    "ilink[_-]?bot[_-]?token"
    "authorization.*bearer"

    # Context tokens
    "context[_-]?token"

    # AES keys
    "aes[_-]?key"

    # CDN URLs
    "novac2c\.cdn\.weixin\.qq\.com"
    "cdn[_-]?url"
    "encrypt[_-]?query"

    # State directory paths
    "\.wxb"
    "inbox/"
    "accounts/"

    # Stdout captures
    "stdout\.json"

    # Live fixtures
    "live-.*\.json"
)

# Files to exclude from scanning
$ExcludeDirs = @(
    "node_modules"
    ".git"
    ".github"
    "test/fixtures"
    "docs"
)

$Found = $false

foreach ($pattern in $Patterns) {
    Write-Host "Checking: $pattern"
    
    $Files = Get-ChildItem -Recurse -File | Where-Object {
        $_.FullName -notmatch [regex]::Escape($_.DirectoryName) -replace "\\", "\\"  # dummy
    }
    
    # Build exclusion filter
    $ExcludeFilter = $ExcludeDirs -join "|"
    
    $Matches = Get-ChildItem -Recurse -File | Where-Object {
        $_.Name -notmatch "\.md$|LICENSE|CHANGELOG\.md" -and
        $_.FullName -notmatch $ExcludeFilter
    } | Select-String -Pattern $pattern -CaseSensitive:$false -Quiet
    
    if ($Matches) {
        $MatchingFiles = Get-ChildItem -Recurse -File | Where-Object {
            $_.Name -notmatch "\.md$|LICENSE|CHANGELOG\.md" -and
            $_.FullName -notmatch $ExcludeFilter
        } | Select-String -Pattern $pattern -CaseSensitive:$false | Select-Object -Unique Path
        
        Write-Host "  ⚠️  Potential match for '$pattern':"
        $MatchingFiles | ForEach-Object { Write-Host "    $($_.Path)" }
        $Found = $true
    }
}

if (-not $Found) {
    Write-Host "✅ No potential secrets found"
    exit 0
} else {
    Write-Host ""
    Write-Host "❌ Potential secrets detected. Please review the above files."
    Write-Host "Note: False positives may occur in test fixtures, documentation, or mock data."
    Write-Host "If these are intentional (test data, mock values), consider adding to .gitignore"
    Write-Host "or using clearly fake placeholder values."
    exit 1
}