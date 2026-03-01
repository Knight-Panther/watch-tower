/**
 * Dynamic content generators for the mock RSS server.
 * Used to produce synthetic RSS feeds for testing edge cases.
 */

/**
 * Generate a valid RSS 2.0 XML document with N articles.
 * Each article has a unique, incrementing title and realistic fields.
 */
export const generateArticles = (count: number): string => {
  const now = new Date();

  const items = Array.from({ length: count }, (_, i) => {
    const index = i + 1;
    const pubDate = new Date(now.getTime() - index * 60 * 60 * 1000); // stagger by 1hr each
    const pubDateStr = pubDate.toUTCString();

    return `  <item>
    <title>Dynamic Article ${index}: Test Content Generation</title>
    <link>https://example.com/dynamic-article/${index}</link>
    <guid>https://example.com/dynamic-article/${index}</guid>
    <description>Auto-generated article number ${index} for mock server testing. This article contains realistic content to simulate a live RSS feed entry during integration tests.</description>
    <pubDate>${pubDateStr}</pubDate>
    <category>Testing</category>
  </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Dynamic Test Feed</title>
    <link>https://example.com</link>
    <description>Dynamically generated feed for testing</description>
    <language>en-us</language>
${items}
  </channel>
</rss>`;
};

/**
 * Generate an oversized RSS XML document of approximately `sizeMb` megabytes.
 * Used to trigger the feed size limit security check (Layer 3).
 *
 * Strategy: produce a single large item whose description is padded with
 * repeated content until the document reaches the target byte count.
 */
export const generateLargeContent = (sizeMb: number): string => {
  const targetBytes = sizeMb * 1024 * 1024;

  // Static envelope overhead
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Oversized Feed</title>
    <link>https://example.com</link>
    <description>Feed designed to exceed size limits</description>
    <language>en-us</language>
    <item>
      <title>Very Large Article</title>
      <link>https://example.com/large</link>
      <guid>https://example.com/large</guid>
      <description>PADDING_PLACEHOLDER</description>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>
  </channel>
</rss>`;

  const paddingNeeded = targetBytes - (envelope.length - "PADDING_PLACEHOLDER".length);
  // Use a repeating ASCII pattern that is valid XML content
  const chunk = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
  const repeats = Math.ceil(Math.max(paddingNeeded, 0) / chunk.length);
  const padding = chunk.repeat(repeats).slice(0, Math.max(paddingNeeded, 0));

  return envelope.replace("PADDING_PLACEHOLDER", padding);
};
