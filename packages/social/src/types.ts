import type { PostTemplateConfig } from "@watch-tower/shared";

export type PostRequest = {
  text: string;
  imageUrl?: string;
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

export interface SocialProvider {
  readonly name: string;
  post(request: PostRequest): Promise<PostResult>;

  // Template-aware formatting (preferred)
  formatPost(article: ArticleForPost, template: PostTemplateConfig): string;

  // Legacy methods (delegate to formatPost with platform defaults)
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
