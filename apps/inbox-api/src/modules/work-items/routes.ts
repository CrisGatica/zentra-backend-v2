import type { FastifyInstance } from "fastify";

import { demoWorkItems } from "../../data/demo-store.js";

export async function registerWorkItemRoutes(app: FastifyInstance) {
  app.get("/v1/work-items", async () => ({
    ok: true,
    items: demoWorkItems,
    total: demoWorkItems.length
  }));
}
