# @watch-tower/llm

LLM provider abstraction for article scoring and summarization. Supports multiple providers with automatic fallback on failures.

## Supported Providers

| Provider | Model Default | Cost (per 1M tokens) | Notes |
|----------|---------------|----------------------|-------|
| **Claude** | `claude-sonnet-4-20250514` | $3 in / $15 out | Best quality, Anthropic |
| **OpenAI** | `gpt-4o-mini` | $0.15 in / $0.6 out | Good balance |
| **DeepSeek** | `deepseek-chat` | $0.14 in / $0.28 out | Cheapest, OpenAI-compatible |

## Quick Start

### 1. Set API Keys

Add to your `.env` file:

```env
# Required: At least one provider key
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

### 2. Choose Primary Provider

```env
LLM_PROVIDER=claude    # Options: claude | openai | deepseek
```

### 3. (Optional) Configure Fallback

```env
LLM_FALLBACK_PROVIDER=openai
```

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | Primary provider | `claude` |
| `LLM_CLAUDE_MODEL` | Claude model override | `claude-sonnet-4-20250514` |
| `LLM_OPENAI_MODEL` | OpenAI model override | `gpt-4o-mini` |
| `LLM_DEEPSEEK_MODEL` | DeepSeek model override | `deepseek-chat` |
| `LLM_FALLBACK_PROVIDER` | Fallback provider (optional) | none |
| `LLM_FALLBACK_MODEL` | Fallback model override | provider default |
| `LLM_AUTO_APPROVE_THRESHOLD` | Score >= X auto-approves | `5` |
| `LLM_AUTO_REJECT_THRESHOLD` | Score <= X auto-rejects | `2` |

### API Keys by Provider

| Provider | Environment Variable |
|----------|---------------------|
| Claude | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

## Example Configurations

### Cheapest (DeepSeek primary, OpenAI fallback)

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...

LLM_FALLBACK_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### Quality First (Claude only)

```env
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

### Balanced (OpenAI primary, Claude fallback)

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

LLM_FALLBACK_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

### Specific Model Override

```env
LLM_PROVIDER=openai
LLM_OPENAI_MODEL=gpt-4o   # Use full GPT-4o instead of mini
OPENAI_API_KEY=sk-...
```

## How Fallback Works

```
Primary Provider Request
    │
    ├─ Success → Return result
    │
    ├─ Parse error (malformed JSON) → Try fallback
    │
    ├─ Auth error (401/403) → Warn + Try fallback
    │
    ├─ Network error (ECONNRESET, timeout) → Try fallback
    │
    ├─ Rate limit (429) → Try fallback
    │
    └─ Server error (500+) → Try fallback
```

### Fallback Triggers

| Error Type | Triggers Fallback | Notes |
|------------|-------------------|-------|
| Parse error | Yes | Model returned invalid JSON |
| Auth error (401/403) | Yes + Warning | Check API key |
| Network errors | Yes | ECONNREFUSED, ETIMEDOUT, etc. |
| Rate limit (429) | Yes | Provider quota exceeded |
| Server errors (5xx) | Yes | Provider API issues |
| Other errors | No | Non-retryable |

### Identifying Fallback Usage

When fallback is used, the `reasoning` field is prefixed:

```json
{
  "score": 4,
  "reasoning": "[via openai] Article covers significant market event..."
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Worker (index.ts)                       │
│                                                          │
│   env.LLM_PROVIDER ──→ getApiKeyForProvider()           │
│   env.LLM_*_MODEL  ──→ getModelForProvider()            │
│                           │                              │
│                           ▼                              │
│              createLLMProviderWithFallback()             │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              LLMProviderWithFallback                     │
│                                                          │
│   Primary: deepseek/deepseek-chat                       │
│      │                                                   │
│      └─ on error ──→ Fallback: claude/sonnet            │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   LLM Providers                          │
│                                                          │
│   ClaudeLLMProvider     (Anthropic SDK)                 │
│   OpenAILLMProvider     (OpenAI SDK)                    │
│   DeepSeekLLMProvider   (OpenAI SDK + custom baseUrl)   │
└─────────────────────────────────────────────────────────┘
```

## Files Overview

| File | Purpose |
|------|---------|
| `types.ts` | `LLMProviderConfig`, `DEFAULT_MODELS`, `DEFAULT_BASE_URLS` |
| `provider.ts` | `LLMProvider` interface, factory functions |
| `claude.ts` | Anthropic Claude provider |
| `openai.ts` | OpenAI provider (reusable for OpenAI-compatible APIs) |
| `deepseek.ts` | DeepSeek provider (extends OpenAI with custom baseUrl) |
| `fallback.ts` | `LLMProviderWithFallback` wrapper |
| `prompts.ts` | Scoring prompt templates |
| `schemas.ts` | Zod schema for response parsing |

## Adding a New Provider

1. **Create provider class** (see `deepseek.ts` for OpenAI-compatible example):

```typescript
// packages/llm/src/newprovider.ts
import { OpenAILLMProvider } from "./openai.js";

export class NewProviderLLMProvider extends OpenAILLMProvider {
  constructor(apiKey: string, model?: string) {
    super(
      apiKey,
      model ?? "default-model",
      "https://api.newprovider.com/v1",
      "newprovider",
    );
  }
}
```

2. **Add to types.ts**:

```typescript
export type LLMProviderType = "claude" | "openai" | "deepseek" | "newprovider";

export const DEFAULT_MODELS: Record<LLMProviderType, string> = {
  // ... existing
  newprovider: "default-model",
};

export const DEFAULT_BASE_URLS: Record<string, string> = {
  // ... existing
  newprovider: "https://api.newprovider.com/v1",
};
```

3. **Add to provider.ts factory**:

```typescript
case "newprovider":
  return new NewProviderLLMProvider(config.apiKey, config.model);
```

4. **Add env schema** (`packages/shared/src/schemas/env.ts`):

```typescript
NEWPROVIDER_API_KEY: z.string().optional().transform(...),
LLM_NEWPROVIDER_MODEL: z.string().optional(),
```

5. **Wire in worker** (`packages/worker/src/index.ts`):

```typescript
// In getApiKeyForProvider:
case "newprovider":
  return env.NEWPROVIDER_API_KEY;

// In getModelForProvider:
case "newprovider":
  return env.LLM_NEWPROVIDER_MODEL;
```

6. **Update .env.example**

## Scoring Logic

Scoring prompts are customizable per-sector via the `scoring_rules` database table:

| Column | Purpose |
|--------|---------|
| `prompt_template` | Custom prompt for sector |
| `auto_approve_threshold` | Score >= X auto-approves |
| `auto_reject_threshold` | Score <= X auto-rejects |
| `model_preference` | (Future) Per-sector model |

Default prompt location: `packages/llm/src/prompts.ts`

## Troubleshooting

### "LLM brain disabled (no API key)"

Missing API key for the configured provider. Check:
- `LLM_PROVIDER` matches your key (`claude` needs `ANTHROPIC_API_KEY`)
- Key is not empty string

### "LLM_FALLBACK_PROVIDER set but no API key found"

Fallback provider configured but key missing. Add the key or remove fallback config.

### Parse errors not triggering fallback

If you see `[deepseek] Parse failed...` but no fallback attempt, ensure:
- `LLM_FALLBACK_PROVIDER` is set
- Fallback provider's API key is present

### Auth errors (401/403) constantly

Check API key validity. The system will fallback but log warnings. Fix the primary key to avoid unnecessary fallback costs.
