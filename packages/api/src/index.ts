import { logger } from "@watch-tower/shared";
import { buildApp } from "./server.js";

const { app, port, closeDb, closeRedis, ingestQueue, maintenanceQueue } = await buildApp();

await app.listen({ port, host: "0.0.0.0" });
logger.info(`[api] listening on port ${port}`);

const shutdown = async () => {
  logger.info("[api] shutting down...");
  setTimeout(() => {
    logger.error("[api] forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
  await app.close();
  await ingestQueue.close();
  await maintenanceQueue.close();
  await closeRedis();
  await closeDb();
  logger.info("[api] shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
