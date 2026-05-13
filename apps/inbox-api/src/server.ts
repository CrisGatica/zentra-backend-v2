import { buildApp } from "./app.js";

const fastify = buildApp();

const port = Number(process.env.PORT) || 10000;
const host = "0.0.0.0";

const start = async () => {
  try {
    await fastify.listen({ port, host });
    fastify.log.info({ host, port }, "zentra-inbox-api listening");
  } catch (error) {
    fastify.log.error(error, "failed to start zentra-inbox-api");
    process.exit(1);
  }
};

void start();
