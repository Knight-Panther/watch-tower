import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_MODELS, DEFAULT_BASE_URLS } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProviderHealthResult = {
  provider: string;
  role: string;
  displayName: string;
  model: string;
  healthy: boolean;
  latencyMs: number;
  error: string | null;
};

export type HealthCheckConfig = {
  llmProvider?: string;
  llmFallbackProvider?: string;
  translationProvider?: string;
  translationModel?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  deepseekApiKey?: string;
  googleAiApiKey?: string;
  embeddingModel?: string;
};

// ─── Per-provider timeout ───────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ─── Individual checkers ────────────────────────────────────────────────────

async function checkClaude(apiKey: string, model: string): Promise<ProviderHealthResult> {
  const start = Date.now();
  try {
    const client = new Anthropic({ apiKey });
    await withTimeout(
      client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      TIMEOUT_MS,
    );
    return {
      provider: "claude",
      role: "",
      displayName: "Claude (Anthropic)",
      model,
      healthy: true,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      provider: "claude",
      role: "",
      displayName: "Claude (Anthropic)",
      model,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkOpenAILLM(apiKey: string, model: string): Promise<ProviderHealthResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: DEFAULT_BASE_URLS.openai });
    await withTimeout(
      client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      TIMEOUT_MS,
    );
    return {
      provider: "openai",
      role: "",
      displayName: "OpenAI",
      model,
      healthy: true,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      provider: "openai",
      role: "",
      displayName: "OpenAI",
      model,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkDeepSeek(apiKey: string, model: string): Promise<ProviderHealthResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: DEFAULT_BASE_URLS.deepseek });
    await withTimeout(
      client.chat.completions.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      TIMEOUT_MS,
    );
    return {
      provider: "deepseek",
      role: "",
      displayName: "DeepSeek",
      model,
      healthy: true,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      provider: "deepseek",
      role: "",
      displayName: "DeepSeek",
      model,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkEmbeddings(apiKey: string, model: string): Promise<ProviderHealthResult> {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey, baseURL: DEFAULT_BASE_URLS.openai });
    await withTimeout(
      client.embeddings.create({ input: "test", model }),
      TIMEOUT_MS,
    );
    return {
      provider: "openai-embeddings",
      role: "embeddings",
      displayName: "OpenAI Embeddings",
      model,
      healthy: true,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      provider: "openai-embeddings",
      role: "embeddings",
      displayName: "OpenAI Embeddings",
      model,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkGemini(apiKey: string, model: string): Promise<ProviderHealthResult> {
  const start = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      }),
      TIMEOUT_MS,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return {
      provider: "gemini",
      role: "translation",
      displayName: "Gemini (Google)",
      model,
      healthy: true,
      latencyMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      provider: "gemini",
      role: "translation",
      displayName: "Gemini (Google)",
      model,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── LLM checker dispatch ───────────────────────────────────────────────────

const LLM_CHECKERS: Record<string, (apiKey: string, model: string) => Promise<ProviderHealthResult>> = {
  claude: checkClaude,
  openai: checkOpenAILLM,
  deepseek: checkDeepSeek,
};

const LLM_API_KEYS: Record<string, keyof HealthCheckConfig> = {
  claude: "anthropicApiKey",
  openai: "openaiApiKey",
  deepseek: "deepseekApiKey",
};

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function checkAllProviders(
  config: HealthCheckConfig,
): Promise<ProviderHealthResult[]> {
  const checks: Promise<ProviderHealthResult>[] = [];

  // 1. Embedding provider (always OpenAI if key exists)
  if (config.openaiApiKey) {
    checks.push(
      checkEmbeddings(config.openaiApiKey, config.embeddingModel ?? "text-embedding-3-small"),
    );
  }

  // 2. LLM primary
  if (config.llmProvider) {
    const checker = LLM_CHECKERS[config.llmProvider];
    const keyField = LLM_API_KEYS[config.llmProvider];
    const apiKey = keyField ? (config[keyField] as string | undefined) : undefined;
    if (checker && apiKey) {
      const model = DEFAULT_MODELS[config.llmProvider as keyof typeof DEFAULT_MODELS] ?? config.llmProvider;
      checks.push(
        checker(apiKey, model).then((r) => ({ ...r, role: "llm-primary" })),
      );
    }
  }

  // 3. LLM fallback
  if (config.llmFallbackProvider && config.llmFallbackProvider !== config.llmProvider) {
    const checker = LLM_CHECKERS[config.llmFallbackProvider];
    const keyField = LLM_API_KEYS[config.llmFallbackProvider];
    const apiKey = keyField ? (config[keyField] as string | undefined) : undefined;
    if (checker && apiKey) {
      const model =
        DEFAULT_MODELS[config.llmFallbackProvider as keyof typeof DEFAULT_MODELS] ??
        config.llmFallbackProvider;
      checks.push(
        checker(apiKey, model).then((r) => ({ ...r, role: "llm-fallback" })),
      );
    }
  }

  // 4. Translation provider
  if (config.translationProvider === "gemini" && config.googleAiApiKey) {
    checks.push(
      checkGemini(
        config.googleAiApiKey,
        config.translationModel ?? "gemini-2.0-flash",
      ),
    );
  } else if (config.translationProvider === "openai" && config.openaiApiKey) {
    // OpenAI for translation — use a chat completion check
    // Skip if already checked as LLM primary/fallback (same endpoint)
    const alreadyChecked =
      config.llmProvider === "openai" || config.llmFallbackProvider === "openai";
    if (!alreadyChecked) {
      checks.push(
        checkOpenAILLM(
          config.openaiApiKey,
          config.translationModel ?? DEFAULT_MODELS.openai,
        ).then((r) => ({ ...r, role: "translation", displayName: "OpenAI (Translation)" })),
      );
    }
  }

  // Run all in parallel
  const settled = await Promise.allSettled(checks);

  return settled.map((result) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    // Shouldn't happen — individual checkers catch their own errors
    return {
      provider: "unknown",
      role: "unknown",
      displayName: "Unknown",
      model: "unknown",
      healthy: false,
      latencyMs: 0,
      error: result.reason instanceof Error ? result.reason.message : "Unknown error",
    };
  });
}
