import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_SCHEMA: z.string().min(1).default("inbox")
});

export type InboxApiEnv = z.infer<typeof envSchema>;

export type EnvLoadResult =
  | {
      ok: true;
      data: InboxApiEnv;
    }
  | {
      ok: false;
      issues: string[];
    };

export function loadInboxApiEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvLoadResult {
  const parsed = envSchema.safeParse(rawEnv);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join(".") || "env";
        return `${path}: ${issue.message}`;
      })
    };
  }

  return {
    ok: true,
    data: parsed.data
  };
}
