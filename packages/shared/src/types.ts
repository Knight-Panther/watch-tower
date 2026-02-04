/**
 * Core entity types shared between API and frontend
 * Note: API responses use snake_case for REST convention
 */

export type Sector = {
  id: string;
  name: string;
  slug: string;
  default_max_age_days: number;
  created_at: string;
};

export type Source = {
  id: string;
  url: string;
  name: string | null;
  active: boolean;
  sector_id: string | null;
  max_age_days: number | null;
  ingest_interval_minutes: number;
  created_at: string;
  last_fetched_at: string | null;
  sectors: {
    id: string;
    name: string;
    slug: string;
    default_max_age_days: number;
  } | null;
};
