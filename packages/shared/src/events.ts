/**
 * Server-Sent Events (SSE) type definitions for real-time UI updates
 *
 * Events flow: Worker → Redis pub/sub → API → SSE → Frontend
 */

// Stats snapshot for dashboard counters
export type PipelineStats = {
  totalArticles: number;
  ingested: number;
  embedded: number;
  duplicates: number;
  scored: number;
  approved: number;
  rejected: number;
};

// Individual event types
export type ArticleIngestedEvent = {
  type: "article:ingested";
  data: {
    id: string;
    title: string;
    url: string;
    sectorId: string | null;
    sourceId: string | null;
  };
};

export type ArticleEmbeddedEvent = {
  type: "article:embedded";
  data: {
    id: string;
    isDuplicate: boolean;
    duplicateOfId: string | null;
    similarityScore: number | null;
  };
};

export type ArticleScoredEvent = {
  type: "article:scored";
  data: {
    id: string;
    score: number;
    summary: string | null;
  };
};

export type ArticleApprovedEvent = {
  type: "article:approved";
  data: {
    id: string;
  };
};

export type ArticleRejectedEvent = {
  type: "article:rejected";
  data: {
    id: string;
  };
};

export type ArticlePostedEvent = {
  type: "article:posted";
  data: {
    id: string;
    platform: string;
    postId: string;
  };
};

export type ArticleTranslatedEvent = {
  type: "article:translated";
  data: {
    id: string;
  };
};

export type SourceFetchedEvent = {
  type: "source:fetched";
  data: {
    sourceId: string;
    sourceName: string | null;
    articlesFound: number;
    articlesAdded: number;
    durationMs: number;
  };
};

export type StatsUpdatedEvent = {
  type: "stats:updated";
  data: PipelineStats;
};

// Union type for all server events
export type ServerEvent =
  | ArticleIngestedEvent
  | ArticleEmbeddedEvent
  | ArticleScoredEvent
  | ArticleApprovedEvent
  | ArticleRejectedEvent
  | ArticlePostedEvent
  | ArticleTranslatedEvent
  | SourceFetchedEvent
  | StatsUpdatedEvent;

