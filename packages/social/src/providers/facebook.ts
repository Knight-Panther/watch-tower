import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

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

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // Facebook: Short, punchy, image-focused, plain text
      if (template.showBreakingLabel && template.breakingEmoji && template.breakingText) {
        parts.push(`${template.breakingEmoji} ${template.breakingText}: ${article.sector.toUpperCase()}`);
      }

      if (template.showTitle) {
        parts.push(article.title);
      }

      // Facebook typically skips long summary, relies on link preview
      if (template.showSummary && article.summary) {
        // Truncate for Facebook
        const truncated =
          article.summary.length > 150 ? article.summary.slice(0, 147) + "..." : article.summary;
        parts.push(truncated);
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
