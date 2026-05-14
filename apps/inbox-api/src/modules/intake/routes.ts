import type { FastifyInstance } from "fastify";

import type { InboxDataAccess } from "../../repositories/index.js";

export async function registerIntakeRoutes(app: FastifyInstance, dataAccess: InboxDataAccess) {
  app.get<{ Querystring: { tenantId?: string } }>("/v1/intake-sessions", async (request, reply) => {
    try {
      const items = await dataAccess.repositories.intakeSessions.list({
        tenantId: request.query.tenantId
      });

      return {
        ok: true,
        source: dataAccess.source,
        issues: dataAccess.issues,
        items,
        total: items.length
      };
    } catch (error) {
      request.log.error(error, "failed to list intake sessions");

      return reply.status(500).send({
        ok: false,
        error: "failed_to_list_intake_sessions"
      });
    }
  });
}
