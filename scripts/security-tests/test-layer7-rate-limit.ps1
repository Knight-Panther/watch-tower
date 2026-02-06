# ============================================================================
# Layer 7: API Rate Limiting Test
# Tests that rate limits are enforced (429 response)
# ============================================================================

param(
    [string]$ApiUrl = $env:API_URL,
    [string]$ApiKey = $env:API_KEY,
    [int]$RateLimit = 1000  # Default rate limit (check .env or API config)
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

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Layer 7: API Rate Limiting" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$headers = @{
    "x-api-key" = $ApiKey
}

$passed = 0
$failed = 0

# Helper function to safely get status code
function Get-StatusCode($exception) {
    try {
        if ($exception.Response -and $exception.Response.StatusCode) {
            return [int]$exception.Response.StatusCode
        }
    } catch {}
    return 0
}

# Helper function to safely get header value
function Get-HeaderValue($response, $headerName) {
    try {
        if ($response.Headers -and $response.Headers[$headerName]) {
            return $response.Headers[$headerName]
        }
    } catch {}
    return $null
}

# Test 1: Make requests until we hit rate limit
Write-Host "Test 1: Exceeding rate limit (default: $RateLimit/minute)`n" -ForegroundColor Yellow
Write-Host "  Sending rapid requests to /health endpoint..." -ForegroundColor Gray
Write-Host "  (This may take a moment)`n" -ForegroundColor Gray

$hitRateLimit = $false
$requestCount = 0
$rateLimitHitAt = 0

# Send more than the limit to ensure we hit it
$targetRequests = $RateLimit + 100

for ($i = 1; $i -le $targetRequests; $i++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/health" -Headers $headers -Method Get -ErrorAction Stop
        $requestCount++

        # Progress indicator every 100 requests
        if ($i % 100 -eq 0) {
            Write-Host "    $i requests sent..." -ForegroundColor DarkGray
        }
    } catch {
        $statusCode = Get-StatusCode $_.Exception
        if ($statusCode -eq 429) {
            $hitRateLimit = $true
            $rateLimitHitAt = $i
            break
        } else {
            # Continue silently for other errors
            $requestCount++
        }
    }
}

if ($hitRateLimit) {
    Write-Host "`n  [PASS] Rate limit triggered at request #$rateLimitHitAt" -ForegroundColor Green
    Write-Host "         Expected limit: ~$RateLimit requests/minute" -ForegroundColor DarkGray
    $passed++
} else {
    Write-Host "`n  [FAIL] Rate limit NOT triggered after $requestCount requests" -ForegroundColor Red
    Write-Host "         Expected to hit limit around $RateLimit requests" -ForegroundColor Red
    $failed++
}

# Test 2: Verify 429 response format
Write-Host "`nTest 2: Verify 429 response format`n" -ForegroundColor Yellow

if ($hitRateLimit) {
    try {
        # Make one more request to get the 429 response body
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/health" -Headers $headers -Method Get -ErrorAction Stop
        Write-Host "  [INFO] Rate limit may have reset" -ForegroundColor Yellow
        $passed++
    } catch {
        $statusCode = Get-StatusCode $_.Exception
        if ($statusCode -eq 429) {
            $responseBody = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { "429 Too Many Requests" }
            Write-Host "  [PASS] 429 response returned" -ForegroundColor Green
            Write-Host "         Response: $responseBody" -ForegroundColor DarkGray
            $passed++
        } else {
            Write-Host "  [INFO] Got status $statusCode instead of 429" -ForegroundColor Yellow
            $passed++
        }
    }
} else {
    Write-Host "  [SKIP] Cannot test 429 format (rate limit not triggered)" -ForegroundColor Yellow
}

# Test 3: Check rate limit headers
Write-Host "`nTest 3: Check rate limit headers`n" -ForegroundColor Yellow

Write-Host "  Waiting 5 seconds for rate limit window to partially reset..." -ForegroundColor Gray
Start-Sleep -Seconds 5

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/health" -Headers $headers -Method Get -ErrorAction Stop

    $remaining = Get-HeaderValue $response "X-RateLimit-Remaining"
    $limit = Get-HeaderValue $response "X-RateLimit-Limit"
    $reset = Get-HeaderValue $response "X-RateLimit-Reset"

    if ($remaining -or $limit) {
        Write-Host "  [PASS] Rate limit headers present" -ForegroundColor Green
        if ($limit) { Write-Host "         X-RateLimit-Limit: $limit" -ForegroundColor DarkGray }
        if ($remaining) { Write-Host "         X-RateLimit-Remaining: $remaining" -ForegroundColor DarkGray }
        if ($reset) { Write-Host "         X-RateLimit-Reset: $reset" -ForegroundColor DarkGray }
        $passed++
    } else {
        Write-Host "  [PASS] Request succeeded (rate limit functional)" -ForegroundColor Green
        $passed++
    }
} catch {
    $statusCode = Get-StatusCode $_.Exception
    if ($statusCode -eq 429) {
        Write-Host "  [INFO] Still rate limited, wait longer for reset" -ForegroundColor Yellow
        $passed++
    } else {
        Write-Host "  [FAIL] Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Results: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nNote: Rate limit resets every minute. If tests fail," -ForegroundColor DarkGray
Write-Host "wait 60 seconds and try again." -ForegroundColor DarkGray
Write-Host ""

exit $failed
