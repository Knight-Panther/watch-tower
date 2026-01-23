import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";
import { JOB_MAINTENANCE_SCHEDULE } from "@watch-tower/shared";

export const registerIngestRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.post("/ingest/run", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    try {
      const job = await deps.maintenanceQueue.add(
        JOB_MAINTENANCE_SCHEDULE,
        {},
        { jobId: `schedule-manual-${Date.now()}` },
      );
      return { queued: true, jobId: job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to enqueue";
      return reply.code(500).send({ error: message });
    }
  });
};
