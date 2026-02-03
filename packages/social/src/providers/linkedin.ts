import { getDefaultTemplate, type PostTemplateConfig } from "@watch-tower/shared";
import type { SocialProvider, PostRequest, PostResult, ArticleForPost } from "../types.js";

export type LinkedInConfig = {
  accessToken: string;
  organizationId: string;
};

export const createLinkedInProvider = (config: LinkedInConfig): SocialProvider => {
  // Suppress unused variable warning - will be used when API is implemented
  void config;

  return {
    name: "linkedin",

    async post(_request: PostRequest): Promise<PostResult> {
      // TODO: Implement LinkedIn API posting
      return {
        platform: "linkedin",
        postId: "",
        success: false,
        error: "LinkedIn posting not implemented yet",
      };
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
