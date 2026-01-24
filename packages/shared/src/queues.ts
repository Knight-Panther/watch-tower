// Pipeline queues
export const QUEUE_INGEST = "pipeline-ingest";
export const QUEUE_SEMANTIC_DEDUP = "pipeline-semantic-dedup";
export const QUEUE_LLM_BRAIN = "pipeline-llm-brain";
export const QUEUE_DISTRIBUTION = "pipeline-distribution";
export const QUEUE_MAINTENANCE = "maintenance";

// Job names
export const JOB_INGEST_FETCH = "ingest-fetch";
export const JOB_SEMANTIC_BATCH = "semantic-batch";
export const JOB_LLM_SCORE_BATCH = "llm-score-batch";
export const JOB_DISTRIBUTION_BUILD = "distribution-build";
export const JOB_DISTRIBUTION_POST = "distribution-post";
export const JOB_MAINTENANCE_CLEANUP = "maintenance-cleanup";
export const JOB_MAINTENANCE_SCHEDULE = "maintenance-schedule";
