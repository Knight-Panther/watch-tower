# Layer 1: Domain Whitelist Test (Manual)

Tests that only whitelisted domains can be added as RSS sources.

## Already Tested

User confirmed this layer is working.

## Quick Re-Test via API

```powershell
# Set variables
$ApiUrl = "http://localhost:3001"
$ApiKey = "local-dev-key"
$headers = @{
    "Content-Type" = "application/json"
    "x-api-key" = $ApiKey
}

# Get a sector ID first
$sectors = Invoke-RestMethod -Uri "$ApiUrl/sectors" -Headers $headers
$sectorId = $sectors[0].id

# Test 1: Try adding non-whitelisted domain (should fail with 403)
$body = @{
    url = "https://malicious-site.com/feed.xml"
    name = "Malicious Feed"
    sector_id = $sectorId
} | ConvertTo-Json

try {
    Invoke-RestMethod -Uri "$ApiUrl/sources" -Method Post -Headers $headers -Body $body
    Write-Host "FAIL: Non-whitelisted domain was accepted!" -ForegroundColor Red
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 403) {
        Write-Host "PASS: Non-whitelisted domain blocked (403)" -ForegroundColor Green
    } else {
        Write-Host "Got status $status (expected 403)" -ForegroundColor Yellow
    }
}

# Test 2: Check whitelist via API
$whitelist = Invoke-RestMethod -Uri "$ApiUrl/site-rules/domains" -Headers $headers
Write-Host "`nCurrent whitelist ($($whitelist.Count) domains):"
$whitelist | ForEach-Object { Write-Host "  - $($_.domain)" }
```

## Quick Re-Test via UI

1. Go to **Site Rules** page → **Domain Whitelist** tab
2. Try adding a source with a non-whitelisted domain
3. Should see error: "Domain not authorized"

## Managing Whitelist

```powershell
# Add a domain
$body = @{ domain = "example.com"; notes = "Test domain" } | ConvertTo-Json
Invoke-RestMethod -Uri "$ApiUrl/site-rules/domains" -Method Post -Headers $headers -Body $body

# Remove a domain
$domainId = "uuid-here"
Invoke-RestMethod -Uri "$ApiUrl/site-rules/domains/$domainId" -Method Delete -Headers $headers
```

## Pass Criteria

- [x] Non-whitelisted domains return 403
- [x] Whitelisted domains are accepted
- [x] UI shows current whitelist
- [x] Can add/remove domains from whitelist
