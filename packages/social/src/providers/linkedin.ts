import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type {
  SocialProvider,
  PostRequest,
  PostResult,
  ArticleForPost,
  HealthCheckResult,
} from "../types.js";

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

        if (request.imageUrl) {
          // 3-step image upload flow for LinkedIn

          // Step 1: Register upload → get uploadUrl + asset URN
          const registerBody = {
            registerUploadRequest: {
              recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
              owner: authorUrn,
              serviceRelationships: [
                {
                  relationshipType: "OWNER",
                  identifier: "urn:li:userGeneratedContent",
                },
              ],
            },
          };

          const registerResp = await fetchWithTimeout(
            `${LINKEDIN_API_BASE}/assets?action=registerUpload`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(registerBody),
            },
            timeoutMs,
          );

          if (!registerResp.ok) {
            const err = (await registerResp.json().catch(() => ({}))) as { message?: string };
            return {
              platform: "linkedin",
              postId: "",
              success: false,
              error: sanitizeError(err.message || `Register upload failed: HTTP ${registerResp.status}`),
            };
          }

          const registerData = (await registerResp.json()) as {
            value: {
              uploadMechanism: {
                "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                  uploadUrl: string;
                };
              };
              asset: string;
            };
          };

          const uploadUrl =
            registerData.value.uploadMechanism[
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
            ].uploadUrl;
          const assetUrn = registerData.value.asset;

          // Step 2: Fetch image from R2 and upload binary to LinkedIn
          const imageResp = await fetchWithTimeout(request.imageUrl, { method: "GET" }, timeoutMs);
          if (!imageResp.ok) {
            return {
              platform: "linkedin",
              postId: "",
              success: false,
              error: `Failed to fetch image from R2: HTTP ${imageResp.status}`,
            };
          }
          const imageBuffer = await imageResp.arrayBuffer();

          const uploadResp = await fetchWithTimeout(
            uploadUrl,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "image/webp",
              },
              body: imageBuffer,
            },
            timeoutMs,
          );

          if (!uploadResp.ok && uploadResp.status !== 201) {
            return {
              platform: "linkedin",
              postId: "",
              success: false,
              error: `Image upload to LinkedIn failed: HTTP ${uploadResp.status}`,
            };
          }

          // Step 3: Create post with image asset
          const textWithoutUrl = request.text.replace(/https?:\/\/[^\s]+/g, "").trim();

          const postBody = {
            author: authorUrn,
            lifecycleState: "PUBLISHED",
            specificContent: {
              "com.linkedin.ugc.ShareContent": {
                shareCommentary: {
                  text: textWithoutUrl,
                },
                shareMediaCategory: "IMAGE",
                media: [
                  {
                    status: "READY",
                    media: assetUrn,
                  },
                ],
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
        }

        // Text/article post (no image)
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

    async healthCheck(): Promise<HealthCheckResult> {
      try {
        // LinkedIn API scope issue: /me requires 'profile' or 'openid' scope
        // Many apps only have 'w_member_social' (posting) scope
        // Strategy: Try /userinfo first (OpenID), then fall back to organization endpoint

        // Attempt 1: Try /v2/userinfo (OpenID Connect - works with 'openid' scope)
        let response = await fetchWithTimeout(
          `${LINKEDIN_API_BASE}/userinfo`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
          timeoutMs,
        );

        // If userinfo fails (no openid scope), try organization endpoint for org accounts
        if (!response.ok && authorType === "organization") {
          response = await fetchWithTimeout(
            `${LINKEDIN_API_BASE}/organizations/${authorId}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "X-Restli-Protocol-Version": "2.0.0",
              },
            },
            timeoutMs,
          );
        }

        // If still failing, try a minimal call to validate token is at least valid
        // by checking if we get 401 (invalid token) vs 403 (valid but no permission)
        if (!response.ok) {
          const status = response.status;

          // 401 = token invalid/expired, 403 = token valid but missing scope
          // For 403, the token itself is valid - posting may still work
          if (status === 403) {
            return {
              platform: "linkedin",
              healthy: true, // Token valid, just missing profile scope
              checkedAt: new Date(),
              // Note: We can't get rate limit headers without profile access
            };
          }

          const errorData = (await response.json().catch(() => ({}))) as { message?: string };
          return {
            platform: "linkedin",
            healthy: false,
            error: sanitizeError(errorData.message || `HTTP ${status}`),
            checkedAt: new Date(),
          };
        }

        // Parse rate limit headers (may not always be present)
        const limitHeader = response.headers.get("X-RateLimit-Limit");
        const remainingHeader = response.headers.get("X-RateLimit-Remaining");
        const resetHeader = response.headers.get("X-RateLimit-Reset");

        const rateLimit: HealthCheckResult["rateLimit"] = {};
        if (limitHeader) rateLimit.limit = parseInt(limitHeader, 10);
        if (remainingHeader) rateLimit.remaining = parseInt(remainingHeader, 10);
        if (resetHeader) rateLimit.resetsAt = new Date(parseInt(resetHeader, 10) * 1000);

        return {
          platform: "linkedin",
          healthy: true,
          rateLimit: Object.keys(rateLimit).length > 0 ? rateLimit : undefined,
          checkedAt: new Date(),
          // Note: tokenExpiresAt calculated in worker from tokenFirstSeenAt + 60 days
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
          healthy: false,
          error,
          checkedAt: new Date(),
        };
      }
    },

    formatPost(article: ArticleForPost, template: PostTemplateConfig): string {
      const parts: string[] = [];

      // LinkedIn: No HTML, plain text only, professional tone
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
