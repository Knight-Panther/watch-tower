// Pipeline queues
export const QUEUE_INGEST = "pipeline-ingest";
export const QUEUE_SEMANTIC_DEDUP = "pipeline-semantic-dedup";
export const QUEUE_LLM_BRAIN = "pipeline-llm-brain";
export const QUEUE_DISTRIBUTION = "pipeline-distribution";
export const QUEUE_TRANSLATION = "pipeline-translation";
export const QUEUE_IMAGE_GENERATION = "pipeline-image-generation";
export const QUEUE_MAINTENANCE = "maintenance";

// Job names
export const JOB_INGEST_FETCH = "ingest-fetch";
export const JOB_SEMANTIC_BATCH = "semantic-batch";
export const JOB_LLM_SCORE_BATCH = "llm-score-batch";
export const JOB_DISTRIBUTION_IMMEDIATE = "distribution-immediate";
export const JOB_MAINTENANCE_CLEANUP = "maintenance-cleanup";
export const JOB_MAINTENANCE_SCHEDULE = "maintenance-schedule";
export const JOB_PLATFORM_HEALTH_CHECK = "platform-health-check";
export const JOB_TRANSLATION_BATCH = "translation-batch";
export const JOB_IMAGE_GENERATE = "image-generate";

// Auto-post stagger delay (45s between posts to avoid bot-spam appearance)
export const AUTO_POST_STAGGER_MS = 45_000;

// Redis pub/sub channels for real-time events
export const REDIS_CHANNEL_EVENTS = "watch-tower:events";
