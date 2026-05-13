import type { FastifyInstance } from "fastify";

import { demoConversations } from "../../data/demo-store.js";

export async function registerConversationRoutes(app: FastifyInstance) {
  app.get("/v1/conversations", async () => ({
    ok: true,
    items: demoConversations,
    total: demoConversations.length
  }));
}
