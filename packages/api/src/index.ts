import { buildApp } from "./server.js";

const { app, port, closeDb, ingestQueue, maintenanceQueue } = await buildApp();

await app.listen({ port, host: "0.0.0.0" });
console.info(`[api] listening on port ${port}`);

const shutdown = async () => {
  console.info("[api] shutting down...");
  setTimeout(() => {
    console.error("[api] forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
  await app.close();
  await ingestQueue.close();
  await maintenanceQueue.close();
  await closeDb();
  console.info("[api] shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
