export type Sector = {
  id: string;
  name: string;
  slug: string;
  default_max_age_days: number;
  ingest_interval_minutes: number | null;
  created_at: string;
};

export type Source = {
  id: string;
  url: string;
  name: string | null;
  active: boolean;
  sector_id: string | null;
  max_age_days: number | null;
  ingest_interval_minutes: number | null;
  created_at: string;
  last_fetched_at: string | null;
  sectors?: Sector | null;
};

export * from "./schemas/env";
export * from "./supabase";
export * from "./queues";
