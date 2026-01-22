import type { FastifyReply, FastifyRequest } from "fastify";

export const createRequireApiKey =
  (apiKey: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!apiKey) {
      return;
    }

    const provided = request.headers["x-api-key"];
    if (provided !== apiKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };
