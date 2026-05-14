import Fastify from "fastify";

import { registerConversationRoutes } from "./modules/conversations/routes.js";
import { registerIntakeRoutes } from "./modules/intake/routes.js";
import { registerTicketRoutes } from "./modules/tickets/routes.js";
import { registerWorkItemRoutes } from "./modules/work-items/routes.js";
import { createInboxDataAccess } from "./repositories/index.js";

export function buildApp() {
  const app = Fastify({
    logger: true
  });
  const dataAccess = createInboxDataAccess();

  app.get("/", async () => ({
    ok: true,
    service: "zentra-inbox-api",
    status: "running",
    dataSource: dataAccess.source
  }));

  app.get("/health", async () => ({
    ok: true,
    service: "zentra-inbox-api"
  }));

  app.register((instance) => registerConversationRoutes(instance, dataAccess));
  app.register((instance) => registerIntakeRoutes(instance, dataAccess));
  app.register((instance) => registerWorkItemRoutes(instance, dataAccess));
  app.register((instance) => registerTicketRoutes(instance, dataAccess));

  return app;
}
