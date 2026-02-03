import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type FacebookConfig = {
  pageId: string;
  accessToken: string;
};

export const createFacebookProvider = (config: FacebookConfig): SocialProvider => {
  // Suppress unused variable warning - will be used when API is implemented
  void config;

  return {
    name: "facebook",

    async post(_request: PostRequest): Promise<PostResult> {
      // TODO: Implement Facebook Graph API posting
      return {
        platform: "facebook",
        postId: "",
        success: false,
        error: "Facebook posting not implemented yet",
      };
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
