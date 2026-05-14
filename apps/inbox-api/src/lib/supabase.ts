import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { InboxApiEnv } from "./env.js";

export function createInboxSupabaseClient(env: InboxApiEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    db: {
      schema: env.SUPABASE_SCHEMA
    }
  });
}
