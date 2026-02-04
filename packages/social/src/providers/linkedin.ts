import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type LinkedInConfig = {
  accessToken: string;
  authorId: string;
  authorType: "person" | "organization";
  timeoutMs?: number;
};

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";
const DEFAULT_TIMEOUT_MS = 30_000;

// Regex to match LinkedIn access tokens in error messages (AQ... format, long alphanumeric)
const LINKEDIN_TOKEN_REGEX = /AQ[A-Za-z0-9_-]{50,}/g;

/**
 * Sanitize error messages to remove any accidentally leaked access tokens
 */
const sanitizeError = (error: string): string => {
  return error.replace(LINKEDIN_TOKEN_REGEX, "***REDACTED***");
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

export const createLinkedInProvider = (config: LinkedInConfig): SocialProvider => {
  const { authorId, authorType, accessToken } = config;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "linkedin",

    async post(request: PostRequest): Promise<PostResult> {
      try {
        const authorUrn = `urn:li:${authorType}:${authorId}`;

        // Extract URL if present for article sharing
        const urlMatch = request.text.match(/https?:\/\/[^\s]+/);
        const textWithoutUrl = request.text.replace(/https?:\/\/[^\s]+/g, "").trim();

        const postBody = {
          author: authorUrn,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: {
                text: textWithoutUrl,
              },
              shareMediaCategory: urlMatch ? "ARTICLE" : "NONE",
              ...(urlMatch && {
                media: [
                  {
                    status: "READY",
                    originalUrl: urlMatch[0],
                  },
                ],
              }),
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
          },
        };

        const response = await fetchWithTimeout(
          `${LINKEDIN_API_BASE}/ugcPosts`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "X-Restli-Protocol-Version": "2.0.0",
            },
            body: JSON.stringify(postBody),
          },
          timeoutMs,
        );

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as { message?: string };
          return {
            platform: "linkedin",
            postId: "",
            success: false,
            error: sanitizeError(errorData.message || `HTTP ${response.status}`),
          };
        }

        const postId = response.headers.get("x-restli-id") || "";
        return {
          platform: "linkedin",
          postId,
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
          platform: "linkedin",
          postId: "",
          success: false,
          error,
        };
      }
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // LinkedIn: No HTML, plain text only, professional tone
      if (template.showBreakingLabel && template.breakingEmoji && template.breakingText) {
        parts.push(`${template.breakingEmoji} ${template.breakingText}`);
      }

      if (template.showTitle) {
        parts.push(article.title);
      }

      if (template.showSummary && article.summary) {
        parts.push(article.summary);
      }

      if (template.showUrl) {
        parts.push(`${template.urlLinkText}: ${article.url}`);
      }

      return parts.join("\n\n");
    },

    formatSinglePost(article: ArticleForPost): string {
      return this.formatPost(article, getDefaultTemplate("linkedin"));
    },

    formatDigestPost(articles: ArticleForPost[], sector: string): string {
      const items = articles.map((a, i) => `${i + 1}. ${a.title}\n   ${a.url}`).join("\n\n");
      return `${sector.toUpperCase()} DIGEST\n\n${items}`;
    },
  };
};
