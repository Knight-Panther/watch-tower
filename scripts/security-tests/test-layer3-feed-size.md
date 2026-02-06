# Layer 3: Feed Size Limit Test (Manual)

Tests that RSS feeds larger than the configured limit (default: 5MB) are rejected.

## Why Manual?

This test requires either:
- A real RSS feed > 5MB (rare in the wild)
- Setting up a local test server to serve a large file
- Mocking at the worker level

## Test Steps

### Option A: Check Worker Logs (Recommended)

1. Start the worker with debug logging:
   ```bash
   LOG_LEVEL=debug npm run dev:worker
   ```

2. If you encounter a large feed naturally, look for logs like:
   ```
   [secure-rss] feed too large (HEAD check)
   ```

3. The log should show the feed size and the limit.

### Option B: Create a Test Server

1. Create a large RSS file (> 5MB):
   ```bash
   # Generate a 6MB RSS file
   node -e "
   const fs = require('fs');
   let rss = '<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Test</title>';
   for (let i = 0; i < 50000; i++) {
     rss += '<item><title>Item ' + i + '</title><description>' + 'x'.repeat(100) + '</description></item>';
   }
   rss += '</channel></rss>';
   fs.writeFileSync('large-feed.xml', rss);
   console.log('Size:', (fs.statSync('large-feed.xml').size / 1024 / 1024).toFixed(2) + ' MB');
   "
   ```

2. Serve it locally:
   ```bash
   npx serve -p 8888 .
   ```

3. Add the source (will be blocked by Layer 1 whitelist unless you add localhost):
   - First add "localhost" to allowed domains (not recommended for production!)
   - Or test directly at the worker level

### Option C: Verify Configuration

1. Check environment variable is set:
   ```powershell
   # In your .env file, verify:
   MAX_FEED_SIZE_MB=5
   ```

2. Check the secure-rss.ts implementation:
   ```typescript
   // packages/worker/src/utils/secure-rss.ts
   // Look for: maxSizeBytes comparison
   ```

## Expected Behavior

When a feed exceeds the size limit:

1. **HEAD request check**: If the server returns `Content-Length` header > 5MB, the feed is rejected immediately without downloading.

2. **Fallback**: If HEAD fails or no Content-Length, the feed is downloaded but parsing may fail for very large files.

3. **Worker log output**:
   ```
   [secure-rss] feed too large (HEAD check)
   Feed size (6MB) exceeds limit (5MB)
   ```

4. **Feed fetch run record**: Status = "error", error_message contains size information.

## Configuration

| Variable | Default | Range |
|----------|---------|-------|
| `MAX_FEED_SIZE_MB` | 5 | 1-50 |

## Pass Criteria

- [ ] Large feeds (> limit) are rejected with clear error message
- [ ] Normal feeds (< limit) are processed successfully
- [ ] Error is logged with size details
