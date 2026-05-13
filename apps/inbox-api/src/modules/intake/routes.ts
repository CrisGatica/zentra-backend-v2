import type { FastifyInstance } from "fastify";

import { demoIntakeSessions } from "../../data/demo-store.js";

export async function registerIntakeRoutes(app: FastifyInstance) {
  app.get("/v1/intake-sessions", async () => ({
    ok: true,
    items: demoIntakeSessions,
    total: demoIntakeSessions.length
  }));
}
