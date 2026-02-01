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
  formatSinglePost(article: ArticleForPost): string;
  formatDigestPost(articles: ArticleForPost[], sector: string): string;
}
