import { loadInboxApiEnv } from "../lib/env.js";
import { createInboxSupabaseClient } from "../lib/supabase.js";
import { createDemoRepositories } from "./demo-source.js";
import { createSupabaseRepositories } from "./supabase-source.js";
import type { InboxRepositories } from "./types.js";

export type InboxDataAccess =
  | {
      source: "supabase";
      issues: [];
      repositories: InboxRepositories;
    }
  | {
      source: "demo";
      issues: string[];
      repositories: InboxRepositories;
    };

export function createInboxDataAccess(): InboxDataAccess {
  const envResult = loadInboxApiEnv();

  if (!envResult.ok) {
    return {
      source: "demo",
      issues: envResult.issues,
      repositories: createDemoRepositories()
    };
  }

  const client = createInboxSupabaseClient(envResult.data);

  return {
    source: "supabase",
    issues: [],
    repositories: createSupabaseRepositories(client)
  };
}
