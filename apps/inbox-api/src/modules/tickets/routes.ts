import type { FastifyInstance } from "fastify";

import { demoTickets } from "../../data/demo-store.js";

export async function registerTicketRoutes(app: FastifyInstance) {
  app.get("/v1/tickets", async () => ({
    ok: true,
    items: demoTickets,
    total: demoTickets.length
  }));
}
