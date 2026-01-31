import { OpenAILLMProvider } from "./openai.js";
import { DEFAULT_MODELS, DEFAULT_BASE_URLS } from "./types.js";

/**
 * DeepSeek LLM Provider.
 *
 * Uses OpenAI-compatible API with DeepSeek's endpoint.
 * Cost-effective alternative: ~$0.14/1M input, ~$0.28/1M output tokens.
 *
 * Supported models:
 * - deepseek-chat (default) - General purpose, good for scoring
 * - deepseek-coder - Optimized for code tasks
 */
export class DeepSeekLLMProvider extends OpenAILLMProvider {
  constructor(apiKey: string, model?: string) {
    super(
      apiKey,
      model ?? DEFAULT_MODELS.deepseek,
      DEFAULT_BASE_URLS.deepseek,
      "deepseek",
    );
  }
}
