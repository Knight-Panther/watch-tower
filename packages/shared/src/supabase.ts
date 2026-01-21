import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SupabaseConfig = {
  url: string;
  serviceRoleKey: string;
};

export const createSupabaseClient = ({
  url,
  serviceRoleKey,
}: SupabaseConfig): SupabaseClient => {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
};
