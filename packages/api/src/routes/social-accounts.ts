import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { socialAccounts } from "@watch-tower/db";
import {
  postTemplateSchema,
  getDefaultTemplate,
  type PostTemplateConfig,
} from "@watch-tower/shared";
import type { ApiDeps } from "../server.js";

export const registerSocialAccountRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /social-accounts - List all configured accounts with templates
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/social-accounts", { preHandler: deps.requireApiKey }, async () => {
    const accounts = await deps.db.select().from(socialAccounts);

    return accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      account_name: a.accountName,
      is_active: a.isActive,
      post_template: (a.postTemplate as PostTemplateConfig | null) ?? getDefaultTemplate(a.platform),
      is_template_custom: a.postTemplate !== null,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    }));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /social-accounts/:id/template - Get template for specific account
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/social-accounts/:id/template",
    { preHandler: deps.requireApiKey },
    async (req, reply) => {
      const { id } = req.params;

      const [account] = await deps.db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, id));

      if (!account) {
        return reply.status(404).send({ error: "Social account not found" });
      }

      const template =
        (account.postTemplate as PostTemplateConfig | null) ?? getDefaultTemplate(account.platform);

      return {
        platform: account.platform,
        template,
        is_default: account.postTemplate === null,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /social-accounts/:id/template - Save template for specific account
  // ─────────────────────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { template: unknown };
  }>(
    "/social-accounts/:id/template",
    { preHandler: deps.requireApiKey },
    async (req, reply) => {
      const { id } = req.params;
      const { template } = req.body ?? {};

      // Validate template
      const parsed = postTemplateSchema.safeParse(template);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid template configuration",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      // Verify account exists
      const [account] = await deps.db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, id));

      if (!account) {
        return reply.status(404).send({ error: "Social account not found" });
      }

      // Update template
      await deps.db
        .update(socialAccounts)
        .set({
          postTemplate: parsed.data,
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, id));

      return {
        success: true,
        platform: account.platform,
        template: parsed.data,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /social-accounts/:id/template - Reset to platform default
  // ─────────────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/social-accounts/:id/template",
    { preHandler: deps.requireApiKey },
    async (req, reply) => {
      const { id } = req.params;

      const [account] = await deps.db
        .select()
        .from(socialAccounts)
        .where(eq(socialAccounts.id, id));

      if (!account) {
        return reply.status(404).send({ error: "Social account not found" });
      }

      // Set to null (will use platform default)
      await deps.db
        .update(socialAccounts)
        .set({
          postTemplate: null,
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, id));

      return {
        success: true,
        message: "Reset to platform default",
        template: getDefaultTemplate(account.platform),
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /social-accounts/preview - Preview formatted post
  // ─────────────────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      platform: string;
      template: unknown;
      article: {
        title: string;
        summary: string;
        url: string;
        sector: string;
      };
    };
  }>(
    "/social-accounts/preview",
    { preHandler: deps.requireApiKey },
    async (req, reply) => {
      const { platform, template, article } = req.body ?? {};

      // Validate template
      const parsedTemplate = postTemplateSchema.safeParse(template);
      if (!parsedTemplate.success) {
        return reply.status(400).send({
          error: "Invalid template",
          details: parsedTemplate.error.flatten().fieldErrors,
        });
      }

      // Validate article has required fields
      if (!article?.title || !article?.url || !article?.sector) {
        return reply.status(400).send({
          error: "Article must have title, url, and sector",
        });
      }

      // Build preview text based on platform
      const t = parsedTemplate.data;
      const parts: string[] = [];

      if (platform === "telegram") {
        // Telegram HTML format
        if (t.showBreakingLabel || t.showSectorTag) {
          let header = "";
          if (t.showBreakingLabel) {
            header += `${t.breakingEmoji} ${t.breakingText}`;
            if (t.showSectorTag) header += `: ${article.sector.toUpperCase()}`;
          } else if (t.showSectorTag) {
            header += `📰 ${article.sector.toUpperCase()}`;
          }
          parts.push(`<b>${header}</b>`);
        }
        if (t.showTitle) parts.push(`<b>${article.title}</b>`);
        if (t.showSummary && article.summary) parts.push(article.summary);
        if (t.showUrl) parts.push(`<a href="${article.url}">${t.urlLinkText}</a>`);
      } else {
        // Plain text for LinkedIn/Facebook
        if (t.showBreakingLabel && t.breakingEmoji && t.breakingText) {
          parts.push(`${t.breakingEmoji} ${t.breakingText}: ${article.sector.toUpperCase()}`);
        }
        if (t.showTitle) parts.push(article.title);
        if (t.showSummary && article.summary) parts.push(article.summary);
        if (t.showUrl) parts.push(`${t.urlLinkText}: ${article.url}`);
      }

      const formattedText = parts.join("\n\n");

      return {
        platform,
        formatted_text: formattedText,
        char_count: formattedText.length,
      };
    },
  );
};
