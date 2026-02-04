/**
 * URL Validator - Security Layer 2
 *
 * Validates URLs for safe fetching, blocking:
 * - Non-HTTP(S) protocols (file://, ftp://, etc.)
 * - Private/internal IP addresses (SSRF protection)
 * - Localhost and loopback addresses
 * - Cloud metadata endpoints
 */

// Private/reserved IP ranges to block (SSRF protection)
const BLOCKED_IP_PATTERNS = [
  /^127\./, // Localhost
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^169\.254\./, // Link-local
  /^0\./, // Invalid
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Carrier-grade NAT
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal", // GCP metadata
  "169.254.169.254", // AWS/Azure/GCP metadata
];

export type UrlValidationResult = {
  valid: boolean;
  error?: string;
  url?: URL;
};

/**
 * Validate URL for safe fetching.
 * Blocks: file://, private IPs, localhost, metadata endpoints.
 */
export const validateFeedUrl = (url: string): UrlValidationResult => {
  // Check basic format
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      valid: false,
      error: `Invalid protocol: ${parsed.protocol} (only http/https allowed)`,
    };
  }

  // Block dangerous hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { valid: false, error: "Localhost and internal URLs not allowed" };
  }

  // Block private IP ranges
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, error: "Private IP addresses not allowed" };
    }
  }

  // Block metadata endpoints (cloud provider internal)
  if (hostname.includes("metadata") || hostname.includes("169.254")) {
    return { valid: false, error: "Metadata endpoints not allowed" };
  }

  return { valid: true, url: parsed };
};
