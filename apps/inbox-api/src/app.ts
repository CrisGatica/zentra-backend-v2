import Fastify from "fastify";

import { registerConversationRoutes } from "./modules/conversations/routes.js";
import { registerIntakeRoutes } from "./modules/intake/routes.js";
import { registerTicketRoutes } from "./modules/tickets/routes.js";
import { registerWorkItemRoutes } from "./modules/work-items/routes.js";

export function buildApp() {
  const app = Fastify({
    logger: true
  });

  app.get("/", async () => ({
    ok: true,
    service: "zentra-inbox-api",
    status: "running"
  }));

  app.get("/health", async () => ({
    ok: true,
    service: "zentra-inbox-api"
  }));

  app.register(registerConversationRoutes);
  app.register(registerIntakeRoutes);
  app.register(registerWorkItemRoutes);
  app.register(registerTicketRoutes);

  return app;
}
