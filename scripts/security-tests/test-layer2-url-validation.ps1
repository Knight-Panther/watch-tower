# ============================================================================
# Layer 2: URL Validation Test
# Tests SSRF protection - blocks file://, localhost, private IPs, metadata
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
Write-Host "  Layer 2: URL Validation (SSRF Protection)" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$passed = 0
$failed = 0

# First, we need a valid sector ID
Write-Host "Getting a valid sector ID..." -ForegroundColor Gray
try {
    $sectors = Invoke-RestMethod -Uri "$ApiUrl/sectors" -Headers $headers -Method Get
    if ($sectors.Count -eq 0) {
        Write-Host "No sectors found. Please run db:seed first." -ForegroundColor Red
        exit 1
    }
    $sectorId = $sectors[0].id
    Write-Host "Using sector: $($sectors[0].name) ($sectorId)`n" -ForegroundColor Gray
} catch {
    Write-Host "Failed to get sectors: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Test cases: URLs that SHOULD be blocked (expect 400)
$blockedUrls = @(
    @{ url = "file:///etc/passwd"; reason = "file:// protocol" },
    @{ url = "file:///C:/Windows/System32/config/SAM"; reason = "file:// Windows path" },
    @{ url = "ftp://ftp.example.com/feed.xml"; reason = "ftp:// protocol" },
    @{ url = "http://localhost/feed.xml"; reason = "localhost hostname" },
    @{ url = "http://127.0.0.1/feed.xml"; reason = "127.0.0.1 loopback" },
    @{ url = "http://0.0.0.0/feed.xml"; reason = "0.0.0.0 address" },
    @{ url = "http://192.168.1.1/feed.xml"; reason = "192.168.x.x private IP" },
    @{ url = "http://192.168.0.100/feed.xml"; reason = "192.168.x.x private IP" },
    @{ url = "http://10.0.0.1/feed.xml"; reason = "10.x.x.x private IP" },
    @{ url = "http://10.255.255.1/feed.xml"; reason = "10.x.x.x private IP" },
    @{ url = "http://172.16.0.1/feed.xml"; reason = "172.16.x.x private IP" },
    @{ url = "http://172.31.255.1/feed.xml"; reason = "172.31.x.x private IP" },
    @{ url = "http://169.254.169.254/latest/meta-data/"; reason = "AWS metadata endpoint" },
    @{ url = "http://metadata.google.internal/"; reason = "GCP metadata endpoint" },
    @{ url = "http://169.254.1.1/feed.xml"; reason = "link-local address" }
)

Write-Host "Testing URLs that SHOULD BE BLOCKED:`n" -ForegroundColor Yellow

foreach ($test in $blockedUrls) {
    $body = @{
        url = $test.url
        name = "Security Test"
        sector_id = $sectorId
        ingest_interval_minutes = 60
    } | ConvertTo-Json

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/sources" -Method Post -Headers $headers -Body $body -ErrorAction Stop
        # If we get here, the request succeeded (BAD - should have been blocked)
        Write-Host "  [FAIL] $($test.reason)" -ForegroundColor Red
        Write-Host "         URL: $($test.url)" -ForegroundColor Red
        Write-Host "         Expected: 400, Got: $($response.StatusCode)" -ForegroundColor Red
        $failed++
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 400) {
            Write-Host "  [PASS] $($test.reason)" -ForegroundColor Green
            Write-Host "         Blocked: $($test.url)" -ForegroundColor DarkGray
            $passed++
        } elseif ($statusCode -eq 403) {
            # 403 means domain whitelist blocked it (also acceptable)
            Write-Host "  [PASS] $($test.reason) (blocked by whitelist)" -ForegroundColor Green
            Write-Host "         Blocked: $($test.url)" -ForegroundColor DarkGray
            $passed++
        } else {
            Write-Host "  [FAIL] $($test.reason)" -ForegroundColor Red
            Write-Host "         URL: $($test.url)" -ForegroundColor Red
            Write-Host "         Expected: 400, Got: $statusCode" -ForegroundColor Red
            $failed++
        }
    }
}

# Test a valid URL (should pass URL validation but may fail whitelist)
Write-Host "`nTesting valid URL format (should pass URL validation):`n" -ForegroundColor Yellow

$validUrl = "https://feeds.reuters.com/reuters/topNews"
$body = @{
    url = $validUrl
    name = "Reuters Test"
    sector_id = $sectorId
    ingest_interval_minutes = 60
} | ConvertTo-Json

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ApiUrl/sources" -Method Post -Headers $headers -Body $body -ErrorAction Stop
    Write-Host "  [PASS] Valid HTTPS URL accepted" -ForegroundColor Green
    Write-Host "         URL: $validUrl" -ForegroundColor DarkGray
    $passed++

    # Clean up - delete the source we just created
    $created = $response.Content | ConvertFrom-Json
    Invoke-RestMethod -Uri "$ApiUrl/sources/$($created.id)" -Method Delete -Headers $headers | Out-Null
    Write-Host "         (cleaned up test source)" -ForegroundColor DarkGray
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 403) {
        Write-Host "  [INFO] Valid URL passed validation but blocked by whitelist (expected)" -ForegroundColor Yellow
        Write-Host "         URL: $validUrl" -ForegroundColor DarkGray
        Write-Host "         Add 'reuters.com' to whitelist if you want to allow it" -ForegroundColor DarkGray
        $passed++  # URL validation passed, whitelist is a separate layer
    } elseif ($statusCode -eq 409) {
        Write-Host "  [PASS] Valid URL accepted (already exists)" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  [FAIL] Valid URL rejected unexpectedly" -ForegroundColor Red
        Write-Host "         URL: $validUrl" -ForegroundColor Red
        Write-Host "         Status: $statusCode" -ForegroundColor Red
        $failed++
    }
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Results: $passed passed, $failed failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "========================================`n" -ForegroundColor Cyan

exit $failed
