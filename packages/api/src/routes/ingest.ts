import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server";
import { JOB_INGEST_POLL } from "@watch-tower/shared";

export const registerIngestRoutes = (app: FastifyInstance, deps: ApiDeps) => {
  app.post("/ingest/run", { preHandler: deps.requireApiKey }, async (_request, reply) => {
    try {
      const job = await deps.ingestQueue.add(
        JOB_INGEST_POLL,
        {},
        { jobId: `ingest-poll-manual-${Date.now()}` },
      );
      return { queued: true, jobId: job.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to enqueue";
      return reply.code(500).send({ error: message });
    }
  });
};
