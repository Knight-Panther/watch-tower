# Security Layer Tests

Manual and automated tests for Watch Tower's 8 security layers.

## Prerequisites

1. **API must be running**: `npm run dev:api`
2. **Set your API key** in `.env` or use `local-dev-key` for development
3. **PowerShell 7+** recommended (works with Windows PowerShell 5.1 too)

## Quick Start

```powershell
# Run all automated tests
.\run-all-tests.ps1

# Or run individual layer tests
.\test-layer2-url-validation.ps1
.\test-layer6-cors.ps1
.\test-layer7-rate-limit.ps1
.\test-layer8-kill-switch.ps1
```

## Test Summary

| Layer | Script | Type | What It Tests |
|-------|--------|------|---------------|
| 2 | `test-layer2-url-validation.ps1` | Automated | SSRF protection (file://, localhost, private IPs) |
| 3 | `test-layer3-feed-size.md` | Manual | Feed size limit (5MB default) |
| 4 | `test-layer4-xxe.md` | Manual | XXE attack protection |
| 5 | `test-layer5-quotas.md` | Manual | Article quota enforcement |
| 6 | `test-layer6-cors.ps1` | Automated | CORS origin blocking |
| 7 | `test-layer7-rate-limit.ps1` | Automated | Rate limiting (429 response) |
| 8 | `test-layer8-kill-switch.ps1` | Automated | Emergency stop toggle |

## Configuration

Scripts automatically read the API key from the project's `.env` file. You can also override via environment variables:

```powershell
$env:API_URL = "http://localhost:3001"
$env:API_KEY = "your-api-key"  # Optional - reads from .env if not set
```

## Expected Results

All tests should show:
- Green checkmarks for passed tests
- Red X for failed tests
- Summary at the end

## Troubleshooting

**"Connection refused"**: API is not running. Start it with `npm run dev:api`

**"401 Unauthorized"**: Wrong API key. Check your `.env` file.

**"Rate limit exceeded"**: Wait 1 minute or restart the API.
