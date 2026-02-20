import type { PostTemplateConfig } from "@watch-tower/shared";

export type PostRequest = {
  text: string;
  imageUrl?: string;
  /** Original article URL — Facebook & LinkedIn use this to auto-comment the source link */
  sourceUrl?: string;
};

export type PostResult = {
  platform: string;
  postId: string;
  success: boolean;
  error?: string;
};

export type ArticleForPost = {
  title: string;
  summary: string;
  url: string;
  sector: string;
};

export interface HealthCheckResult {
  platform: string;
  healthy: boolean;
  error?: string;

  // Token expiry (Facebook only - from API; LinkedIn calculated from firstSeenAt)
  tokenExpiresAt?: Date;

  // Platform rate limits (captured from response headers)
  rateLimit?: {
    remaining?: number; // LinkedIn: X-RateLimit-Remaining
    limit?: number; // LinkedIn: X-RateLimit-Limit
    percent?: number; // Facebook: X-App-Usage call_count
    resetsAt?: Date; // LinkedIn: X-RateLimit-Reset
  };

  checkedAt: Date;
}

export interface SocialProvider {
  readonly name: string;
  post(request: PostRequest): Promise<PostResult>;
  healthCheck(): Promise<HealthCheckResult>;

  // Template-aware formatting (preferred)
  formatPost(article: ArticleForPost, template: PostTemplateConfig): string;

  // Legacy methods (delegate to formatPost with platform defaults)
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
