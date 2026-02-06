# ============================================================================
# Layer 8: Kill Switch (Emergency Stop) Test
# Tests that emergency stop can be toggled and persists
# ============================================================================

param(
    [string]$ApiUrl = $env:API_URL,
    [string]$ApiKey = $env:API_KEY
)

# Defaults - try to read API key from .env file
if (-not $ApiUrl) { $ApiUrl = "http://localhost:3001" }
if (-not $ApiKey) {
    $envFile = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))) ".env"
    if (Test-Path $envFile) {
        $envContent = Get-Content $envFile | Where-Object { $_ -match "^API_KEY=" }
        if ($envContent) {
            $ApiKey = ($envContent -split "=", 2)[1]
        }
    }
    if (-not $ApiKey) { $ApiKey = "local-dev-key" }
}

$headers = @{
    "Content-Type" = "application/json"
    "x-api-key" = $ApiKey
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Layer 8: Kill Switch (Emergency Stop)" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$passed = 0
$failed = 0

# Test 1: Get current kill switch status
Write-Host "Test 1: Get current kill switch status`n" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Get
    $initialState = $response.enabled
    Write-Host "  [PASS] Retrieved current status" -ForegroundColor Green
    Write-Host "         Current state: $(if ($initialState) { 'ENABLED (posting stopped)' } else { 'DISABLED (posting active)' })" -ForegroundColor DarkGray
    $passed++
} catch {
    Write-Host "  [FAIL] Could not get kill switch status" -ForegroundColor Red
    Write-Host "         Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
    $initialState = $false
}

# Test 2: Enable kill switch
Write-Host "`nTest 2: Enable kill switch`n" -ForegroundColor Yellow

$body = @{ enabled = $true } | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Post -Body $body
    if ($response.enabled -eq $true) {
        Write-Host "  [PASS] Kill switch ENABLED" -ForegroundColor Green
        Write-Host "         All social posting is now STOPPED" -ForegroundColor Yellow
        $passed++
    } else {
        Write-Host "  [FAIL] Kill switch not enabled" -ForegroundColor Red
        Write-Host "         Response: $($response | ConvertTo-Json)" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  [FAIL] Could not enable kill switch" -ForegroundColor Red
    Write-Host "         Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# Test 3: Verify kill switch persisted
Write-Host "`nTest 3: Verify kill switch state persisted`n" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Get
    if ($response.enabled -eq $true) {
        Write-Host "  [PASS] Kill switch state persisted correctly" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  [FAIL] Kill switch state not persisted" -ForegroundColor Red
        Write-Host "         Expected: enabled=true, Got: enabled=$($response.enabled)" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  [FAIL] Could not verify kill switch state" -ForegroundColor Red
    Write-Host "         Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# Test 4: Disable kill switch
Write-Host "`nTest 4: Disable kill switch`n" -ForegroundColor Yellow

$body = @{ enabled = $false } | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Post -Body $body
    if ($response.enabled -eq $false) {
        Write-Host "  [PASS] Kill switch DISABLED" -ForegroundColor Green
        Write-Host "         Social posting is now ACTIVE" -ForegroundColor DarkGray
        $passed++
    } else {
        Write-Host "  [FAIL] Kill switch not disabled" -ForegroundColor Red
        Write-Host "         Response: $($response | ConvertTo-Json)" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  [FAIL] Could not disable kill switch" -ForegroundColor Red
    Write-Host "         Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

# Test 5: Verify disabled state
Write-Host "`nTest 5: Verify disabled state persisted`n" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Get
    if ($response.enabled -eq $false) {
        Write-Host "  [PASS] Disabled state persisted correctly" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  [FAIL] Disabled state not persisted" -ForegroundColor Red
        $failed++
    }
} catch {
    Write-Host "  [FAIL] Could not verify disabled state" -ForegroundColor Red
    $failed++
}

# Test 6: Invalid input handling
Write-Host "`nTest 6: Invalid input handling`n" -ForegroundColor Yellow

$body = @{ enabled = "not-a-boolean" } | ConvertTo-Json

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Post -Body $body -ErrorAction Stop
    Write-Host "  [FAIL] Invalid input was accepted" -ForegroundColor Red
    $failed++
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 400) {
        Write-Host "  [PASS] Invalid input rejected with 400" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  [WARN] Invalid input rejected but with unexpected status: $statusCode" -ForegroundColor Yellow
        $passed++
    }
}

# Restore original state
Write-Host "`nRestoring original state..." -ForegroundColor Gray
$body = @{ enabled = $initialState } | ConvertTo-Json
try {
    Invoke-RestMethod -Uri "$ApiUrl/config/emergency-stop" -Headers $headers -Method Post -Body $body | Out-Null
    Write-Host "  Restored to: $(if ($initialState) { 'ENABLED' } else { 'DISABLED' })" -ForegroundColor DarkGray
} catch {
    Write-Host "  Warning: Could not restore original state" -ForegroundColor Yellow
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Results: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nNote: The kill switch is checked by the worker during posting." -ForegroundColor DarkGray
Write-Host "To fully test, enable it and verify worker logs show 'emergency stop active'." -ForegroundColor DarkGray
Write-Host ""

exit $failed
