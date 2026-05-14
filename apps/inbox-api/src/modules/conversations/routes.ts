import type { FastifyInstance } from "fastify";

import type { InboxDataAccess } from "../../repositories/index.js";

export async function registerConversationRoutes(app: FastifyInstance, dataAccess: InboxDataAccess) {
  app.get<{ Querystring: { tenantId?: string } }>("/v1/conversations", async (request, reply) => {
    try {
      const items = await dataAccess.repositories.conversations.list({
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
      request.log.error(error, "failed to list conversations");

      return reply.status(500).send({
        ok: false,
        error: "failed_to_list_conversations"
      });
    }
  });
}
