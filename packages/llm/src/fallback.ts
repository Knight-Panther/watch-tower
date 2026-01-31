import type { LLMProvider } from "./provider.js";
import type { ScoringRequest, ScoringResult } from "./types.js";
import { logger } from "@watch-tower/shared";

/**
 * Network error codes that should trigger fallback.
 */
const RETRYABLE_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
];

/**
 * HTTP status codes that should trigger fallback.
 */
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Auth error codes - these trigger fallback but with a warning.
 */
const AUTH_ERROR_CODES = [401, 403];

type RetryableErrorResult = {
  retryable: boolean;
  isAuthError: boolean;
  reason?: string;
};

/**
 * Check if an error should trigger fallback to another provider.
 * Returns detailed info about the error type.
 */
const analyzeError = (error: unknown): RetryableErrorResult => {
  if (!(error instanceof Error)) {
    return { retryable: false, isAuthError: false };
  }

  const message = error.message.toLowerCase();
  const anyError = error as unknown as Record<string, unknown>;

  // Check error.code (Node.js network errors)
  if (typeof anyError.code === "string") {
    const code = anyError.code.toUpperCase();
    if (RETRYABLE_ERROR_CODES.includes(code)) {
      return { retryable: true, isAuthError: false, reason: `error.code=${code}` };
    }
  }

  // Check error.cause.code (nested errors)
  if (anyError.cause && typeof anyError.cause === "object") {
    const cause = anyError.cause as Record<string, unknown>;
    if (typeof cause.code === "string") {
      const code = cause.code.toUpperCase();
      if (RETRYABLE_ERROR_CODES.includes(code)) {
        return { retryable: true, isAuthError: false, reason: `cause.code=${code}` };
      }
    }
  }

  // Network errors from message
  if (
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up")
  ) {
    return { retryable: true, isAuthError: false, reason: "network error in message" };
  }

  // Check for status code in error message
  const statusMatch = message.match(/status[:\s]*(\d{3})/i);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (AUTH_ERROR_CODES.includes(status)) {
      return { retryable: true, isAuthError: true, reason: `status=${status} (auth)` };
    }
    if (RETRYABLE_STATUS_CODES.includes(status) || status >= 500) {
      return { retryable: true, isAuthError: false, reason: `status=${status}` };
    }
  }

  // OpenAI/Anthropic SDK specific error properties
  if (typeof anyError.status === "number") {
    const status = anyError.status;
    if (AUTH_ERROR_CODES.includes(status)) {
      return { retryable: true, isAuthError: true, reason: `error.status=${status} (auth)` };
    }
    if (RETRYABLE_STATUS_CODES.includes(status) || status >= 500) {
      return { retryable: true, isAuthError: false, reason: `error.status=${status}` };
    }
  }

  return { retryable: false, isAuthError: false };
};

/**
 * LLM Provider with automatic fallback on failures.
 *
 * Triggers fallback on:
 * - API errors (network, rate limit, server errors)
 * - Auth errors (401, 403) with warning
 * - Parse errors (malformed JSON from model)
 *
 * Usage:
 * ```ts
 * const provider = new LLMProviderWithFallback(
 *   claudeProvider,   // Primary
 *   openaiProvider,   // Fallback
 * );
 * ```
 */
export class LLMProviderWithFallback implements LLMProvider {
  readonly name: string;
  readonly model: string;
  // Expose fallback provider info for telemetry
  readonly fallbackName: string | null;
  readonly fallbackModel: string | null;

  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider | null,
  ) {
    this.name = fallback ? `${primary.name}→${fallback.name}` : primary.name;
    this.model = primary.model;
    this.fallbackName = fallback?.name ?? null;
    this.fallbackModel = fallback?.model ?? null;
  }

  private async tryFallback(
    request: ScoringRequest,
    reason: string,
  ): Promise<ScoringResult> {
    if (!this.fallback) {
      throw new Error(`Primary provider failed: ${reason}`);
    }

    logger.warn(
      `[llm-fallback] primary (${this.primary.name}) failed, trying fallback (${this.fallback.name}): ${reason}`,
    );

    const result = await this.fallback.score(request);

    // Tag the result so we know fallback was used (for debugging/metrics)
    return {
      ...result,
      reasoning: result.reasoning
        ? `[via ${this.fallback.name}] ${result.reasoning}`
        : `[via ${this.fallback.name}]`,
      isFallback: true, // Mark for telemetry
    };
  }

  async score(request: ScoringRequest): Promise<ScoringResult> {
    try {
      const result = await this.primary.score(request);

      // Check for parse errors - if fallback configured, try it
      if (result.error && this.fallback) {
        logger.warn(
          `[llm-fallback] primary (${this.primary.name}) returned parse error for ${request.articleId}: ${result.error}`,
        );
        return this.tryFallback(request, `parse error: ${result.error}`);
      }

      return result;
    } catch (error) {
      // If no fallback configured, just rethrow
      if (!this.fallback) {
        throw error;
      }

      // Analyze the error
      const analysis = analyzeError(error);

      if (!analysis.retryable) {
        logger.warn(
          `[llm-fallback] primary (${this.primary.name}) failed with non-retryable error, not falling back`,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }

      // Warn specifically for auth errors - might indicate misconfiguration
      if (analysis.isAuthError) {
        logger.warn(
          `[llm-fallback] primary (${this.primary.name}) auth error (${analysis.reason}) - check API key. Falling back to ${this.fallback.name}`,
        );
      }

      return this.tryFallback(
        request,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
