import type { FastifyInstance } from "fastify";
import { getConfiguredBalances, getProviderDisplayName } from "@watch-tower/llm";
import type { ApiDeps } from "../server.js";

const CACHE_KEY = "provider:balances";
const CACHE_TTL_SECONDS = 300; // 5 minutes

export const registerCreditsRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  /**
   * GET /credits
   * Returns balance information for all configured LLM providers.
   * Results are cached for 5 minutes to avoid excessive API calls.
   */
  app.get("/credits", { preHandler: deps.requireApiKey }, async () => {
    // Check cache first
    const cached = await deps.redis.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Corrupt cache entry - ignore and regenerate
      }
    }

    // Fetch balances from all configured providers
    const balances = await getConfiguredBalances(process.env);

    const result = {
      providers: balances.map((b) => ({
        provider: b.provider,
        display_name: getProviderDisplayName(b.provider),
        available: b.available,
        currency: b.currency,
        total_balance: b.totalBalance,
        granted_balance: b.grantedBalance ?? null,
        topped_up_balance: b.toppedUpBalance ?? null,
        error: b.error ?? null,
      })),
      generated_at: new Date().toISOString(),
    };

    // Cache result
    await deps.redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(result));

    return result;
  });

  /**
   * POST /credits/refresh
   * Force refresh balance information, bypassing cache.
   */
  app.post("/credits/refresh", { preHandler: deps.requireApiKey }, async () => {
    // Clear cache
    await deps.redis.del(CACHE_KEY);

    // Fetch fresh balances
    const balances = await getConfiguredBalances(process.env);

    const result = {
      providers: balances.map((b) => ({
        provider: b.provider,
        display_name: getProviderDisplayName(b.provider),
        available: b.available,
        currency: b.currency,
        total_balance: b.totalBalance,
        granted_balance: b.grantedBalance ?? null,
        topped_up_balance: b.toppedUpBalance ?? null,
        error: b.error ?? null,
      })),
      generated_at: new Date().toISOString(),
    };

    // Cache result
    await deps.redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(result));

    return result;
  });
};
