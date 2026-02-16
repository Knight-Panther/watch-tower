import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type {
  SocialProvider,
  PostRequest,
  PostResult,
  ArticleForPost,
  HealthCheckResult,
} from "../types.js";

export type FacebookConfig = {
  pageId: string;
  accessToken: string;
  timeoutMs?: number;
};

const GRAPH_API_VERSION = "v18.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const DEFAULT_TIMEOUT_MS = 30_000;

// Regex to match Facebook access tokens in error messages (EAA... format, 100+ chars)
const FB_TOKEN_REGEX = /EAA[A-Za-z0-9]+/g;

/**
 * Sanitize error messages to remove any accidentally leaked access tokens
 */
const sanitizeError = (error: string): string => {
  return error.replace(FB_TOKEN_REGEX, "***REDACTED***");
};

/**
 * Fetch with timeout support using AbortController.
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const createFacebookProvider = (config: FacebookConfig): SocialProvider => {
  const { pageId, accessToken } = config;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "facebook",

    async post(request: PostRequest): Promise<PostResult> {
      try {
        if (request.imageUrl) {
          // Image post: use /photos endpoint — Facebook downloads the image from URL
          const url = `${GRAPH_API_BASE}/${pageId}/photos`;

          const body: Record<string, string> = {
            url: request.imageUrl,
            caption: request.text,
            access_token: accessToken,
          };

          const response = await fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(body),
            },
            timeoutMs,
          );

          const result = (await response.json()) as {
            id?: string;
            post_id?: string;
            error?: { message: string };
          };

          if (!response.ok || result.error) {
            return {
              platform: "facebook",
              postId: "",
              success: false,
              error: sanitizeError(result.error?.message || `HTTP ${response.status}`),
            };
          }

          const postId = result.post_id || result.id || "";

          // Auto-comment source URL on image posts (keeps post text clean on mobile)
          if (request.sourceUrl && postId) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
              const commentUrl = `${GRAPH_API_BASE}/${postId}/comments`;
              await fetchWithTimeout(
                commentUrl,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                    message: request.sourceUrl,
                    access_token: accessToken,
                  }),
                },
                timeoutMs,
              );
            } catch {
              // Comment failure is non-critical — post itself succeeded
            }
          }

          return {
            platform: "facebook",
            postId,
            success: true,
          };
        }

        // Text post: use /feed endpoint with link preview
        const url = `${GRAPH_API_BASE}/${pageId}/feed`;

        const body: Record<string, string> = {
          message: request.text,
          access_token: accessToken,
        };

        // Extract URL from text for link preview
        const urlMatch = request.text.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          body.link = urlMatch[0];
        }

        const response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(body),
          },
          timeoutMs,
        );

        const result = (await response.json()) as { id?: string; error?: { message: string } };

        if (!response.ok || result.error) {
          return {
            platform: "facebook",
            postId: "",
            success: false,
            error: sanitizeError(result.error?.message || `HTTP ${response.status}`),
          };
        }

        return {
          platform: "facebook",
          postId: result.id || "",
          success: true,
        };
      } catch (err) {
        let error: string;
        if (err instanceof Error) {
          if (err.name === "AbortError") {
            error = `Request timeout after ${timeoutMs}ms`;
          } else {
            error = sanitizeError(err.message);
          }
        } else {
          error = "Unknown error";
        }
        return {
          platform: "facebook",
          postId: "",
          success: false,
          error,
        };
      }
    },

    async healthCheck(): Promise<HealthCheckResult> {
      try {
        // Use debug_token to check token validity and get expiry
        const debugUrl = `${GRAPH_API_BASE}/debug_token?input_token=${accessToken}&access_token=${accessToken}`;

        const response = await fetchWithTimeout(debugUrl, { method: "GET" }, timeoutMs);
        const result = (await response.json()) as {
          data?: { is_valid: boolean; expires_at?: number };
          error?: { message: string };
        };

        if (result.error || !result.data?.is_valid) {
          return {
            platform: "facebook",
            healthy: false,
            error: sanitizeError(result.error?.message || "Token invalid"),
            checkedAt: new Date(),
          };
        }

        // Parse rate limit headers (X-App-Usage)
        const appUsage = response.headers.get("X-App-Usage");
        let rateLimit: HealthCheckResult["rateLimit"];
        if (appUsage) {
          try {
            const usage = JSON.parse(appUsage) as {
              call_count?: number;
              total_cputime?: number;
              total_time?: number;
            };
            rateLimit = {
              percent: Math.max(usage.call_count || 0, usage.total_cputime || 0, usage.total_time || 0),
            };
          } catch {
            // Ignore parse errors
          }
        }

        // Get token expiry from debug_token response
        // Handle expires_at = 0 as "never expires" (long-lived page tokens)
        const expiresAt =
          result.data.expires_at && result.data.expires_at > 0
            ? new Date(result.data.expires_at * 1000)
            : undefined;

        return {
          platform: "facebook",
          healthy: true,
          tokenExpiresAt: expiresAt,
          rateLimit,
          checkedAt: new Date(),
        };
      } catch (err) {
        let error: string;
        if (err instanceof Error) {
          if (err.name === "AbortError") {
            error = `Request timeout after ${timeoutMs}ms`;
          } else {
            error = sanitizeError(err.message);
          }
        } else {
          error = "Unknown error";
        }

        return {
          platform: "facebook",
          healthy: false,
          error,
          checkedAt: new Date(),
        };
      }
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // Facebook: Short, punchy, image-focused, plain text
      // 1. Breaking label + Sector tag (first line)
      if (template.showBreakingLabel || template.showSectorTag) {
        let header = "";
        if (template.showBreakingLabel && template.breakingEmoji && template.breakingText) {
          header += `${template.breakingEmoji} ${template.breakingText}`;
          if (template.showSectorTag) {
            header += `: ${article.sector.toUpperCase()}`;
          }
        } else if (template.showSectorTag) {
          header += `📰 ${article.sector.toUpperCase()}`;
        }
        if (header) parts.push(header);
      }

      if (template.showTitle) {
        parts.push(article.title);
      }

      if (template.showSummary && article.summary) {
        parts.push(article.summary);
      }

      if (template.showUrl) {
        parts.push(`${template.urlLinkText}\n${article.url}`);
      }

      return parts.join("\n\n");
    },

    formatSinglePost(article: ArticleForPost): string {
      return this.formatPost(article, getDefaultTemplate("facebook"));
    },

    formatDigestPost(articles: ArticleForPost[], sector: string): string {
      const items = articles.map((a, i) => `${i + 1}. ${a.title}`).join("\n");
      return `📰 ${sector.toUpperCase()} DIGEST\n\n${items}`;
    },
  };
};
