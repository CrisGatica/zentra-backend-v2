import Fastify from "fastify";

const app = Fastify({
  logger: true
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "zentra-inbox-api"
  };
});

const port = Number(process.env.PORT ?? 3000);
const host = "0.0.0.0";

const start = async () => {
  try {
    await app.listen({ port, host });
    app.log.info({ host, port }, "zentra-inbox-api listening");
  } catch (error) {
    app.log.error(error, "failed to start zentra-inbox-api");
    process.exit(1);
  }
};

void start();
