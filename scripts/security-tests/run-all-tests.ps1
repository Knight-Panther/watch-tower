# ============================================================================
# Security Layer Tests - Master Runner
# Runs all automated security tests for layers 2, 6, 7, 8
# ============================================================================

param(
    [string]$ApiUrl = $env:API_URL,
    [string]$ApiKey = $env:API_KEY,
    [switch]$SkipRateLimit  # Rate limit test is slow and exhausts the limit
)

# Defaults - try to read API key from .env file
if (-not $ApiUrl) { $ApiUrl = "http://localhost:3001" }
if (-not $ApiKey) {
    $envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
    if (Test-Path $envFile) {
        $envContent = Get-Content $envFile | Where-Object { $_ -match "^API_KEY=" }
        if ($envContent) {
            $ApiKey = ($envContent -split "=", 2)[1]
        }
    }
    if (-not $ApiKey) { $ApiKey = "local-dev-key" }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║        WATCH TOWER - Security Layer Test Suite                 ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  API URL: $ApiUrl" -ForegroundColor Gray
Write-Host "  API Key: $($ApiKey.Substring(0, [Math]::Min(4, $ApiKey.Length)))****" -ForegroundColor Gray
Write-Host ""

# Check if API is running
Write-Host "Checking API connectivity..." -ForegroundColor Gray
try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/health" -Headers @{ "x-api-key" = $ApiKey } -Method Get -TimeoutSec 5
    Write-Host "  API is running" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "  ERROR: Cannot connect to API at $ApiUrl" -ForegroundColor Red
    Write-Host "  Make sure the API is running: npm run dev:api" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

$totalPassed = 0
$totalFailed = 0
$results = @()

# ─────────────────────────────────────────────────────────────────────────────
# Layer 2: URL Validation
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "Running Layer 2 tests..." -ForegroundColor Gray
$env:API_URL = $ApiUrl
$env:API_KEY = $ApiKey

$layer2Script = Join-Path $scriptDir "test-layer2-url-validation.ps1"
if (Test-Path $layer2Script) {
    & $layer2Script
    $layer2Exit = $LASTEXITCODE
    if ($layer2Exit -eq 0) {
        $results += @{ Layer = "2 - URL Validation"; Status = "PASSED"; Failed = 0 }
        $totalPassed++
    } else {
        $results += @{ Layer = "2 - URL Validation"; Status = "FAILED"; Failed = $layer2Exit }
        $totalFailed++
    }
} else {
    Write-Host "  Script not found: $layer2Script" -ForegroundColor Red
    $results += @{ Layer = "2 - URL Validation"; Status = "SKIPPED"; Failed = 0 }
}

# ─────────────────────────────────────────────────────────────────────────────
# Layer 6: CORS
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nRunning Layer 6 tests..." -ForegroundColor Gray

$layer6Script = Join-Path $scriptDir "test-layer6-cors.ps1"
if (Test-Path $layer6Script) {
    & $layer6Script
    $layer6Exit = $LASTEXITCODE
    if ($layer6Exit -eq 0) {
        $results += @{ Layer = "6 - CORS Whitelist"; Status = "PASSED"; Failed = 0 }
        $totalPassed++
    } else {
        $results += @{ Layer = "6 - CORS Whitelist"; Status = "FAILED"; Failed = $layer6Exit }
        $totalFailed++
    }
} else {
    Write-Host "  Script not found: $layer6Script" -ForegroundColor Red
    $results += @{ Layer = "6 - CORS Whitelist"; Status = "SKIPPED"; Failed = 0 }
}

# ─────────────────────────────────────────────────────────────────────────────
# Layer 7: Rate Limiting (optional, slow)
# ─────────────────────────────────────────────────────────────────────────────
if ($SkipRateLimit) {
    Write-Host "`nSkipping Layer 7 tests (use without -SkipRateLimit to run)" -ForegroundColor Yellow
    $results += @{ Layer = "7 - Rate Limiting"; Status = "SKIPPED"; Failed = 0 }
} else {
    Write-Host "`nRunning Layer 7 tests (this may take a minute)..." -ForegroundColor Gray

    $layer7Script = Join-Path $scriptDir "test-layer7-rate-limit.ps1"
    if (Test-Path $layer7Script) {
        & $layer7Script
        $layer7Exit = $LASTEXITCODE
        if ($layer7Exit -eq 0) {
            $results += @{ Layer = "7 - Rate Limiting"; Status = "PASSED"; Failed = 0 }
            $totalPassed++
        } else {
            $results += @{ Layer = "7 - Rate Limiting"; Status = "FAILED"; Failed = $layer7Exit }
            $totalFailed++
        }
    } else {
        Write-Host "  Script not found: $layer7Script" -ForegroundColor Red
        $results += @{ Layer = "7 - Rate Limiting"; Status = "SKIPPED"; Failed = 0 }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Layer 8: Kill Switch
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nRunning Layer 8 tests..." -ForegroundColor Gray

$layer8Script = Join-Path $scriptDir "test-layer8-kill-switch.ps1"
if (Test-Path $layer8Script) {
    & $layer8Script
    $layer8Exit = $LASTEXITCODE
    if ($layer8Exit -eq 0) {
        $results += @{ Layer = "8 - Kill Switch"; Status = "PASSED"; Failed = 0 }
        $totalPassed++
    } else {
        $results += @{ Layer = "8 - Kill Switch"; Status = "FAILED"; Failed = $layer8Exit }
        $totalFailed++
    }
} else {
    Write-Host "  Script not found: $layer8Script" -ForegroundColor Red
    $results += @{ Layer = "8 - Kill Switch"; Status = "SKIPPED"; Failed = 0 }
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║                      TEST SUMMARY                              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

foreach ($result in $results) {
    $statusColor = switch ($result.Status) {
        "PASSED" { "Green" }
        "FAILED" { "Red" }
        "SKIPPED" { "Yellow" }
    }
    $icon = switch ($result.Status) {
        "PASSED" { "[OK]" }
        "FAILED" { "[XX]" }
        "SKIPPED" { "[--]" }
    }
    Write-Host "  $icon $($result.Layer)" -ForegroundColor $statusColor
}

Write-Host ""
Write-Host "─────────────────────────────────────────────────────────────────" -ForegroundColor Gray

$automatedLayers = $results | Where-Object { $_.Status -ne "SKIPPED" }
$passedCount = ($automatedLayers | Where-Object { $_.Status -eq "PASSED" }).Count
$failedCount = ($automatedLayers | Where-Object { $_.Status -eq "FAILED" }).Count

if ($failedCount -eq 0) {
    Write-Host "  All automated tests PASSED ($passedCount/$($automatedLayers.Count))" -ForegroundColor Green
} else {
    Write-Host "  Some tests FAILED: $passedCount passed, $failedCount failed" -ForegroundColor Red
}

Write-Host ""
Write-Host "─────────────────────────────────────────────────────────────────" -ForegroundColor Gray
Write-Host ""
Write-Host "  Manual tests required for:" -ForegroundColor Yellow
Write-Host "    - Layer 3: Feed Size Limit (see test-layer3-feed-size.md)" -ForegroundColor Gray
Write-Host "    - Layer 4: XXE Protection (see test-layer4-xxe.md)" -ForegroundColor Gray
Write-Host "    - Layer 5: Article Quotas (see test-layer5-quotas.md)" -ForegroundColor Gray
Write-Host ""

exit $failedCount
