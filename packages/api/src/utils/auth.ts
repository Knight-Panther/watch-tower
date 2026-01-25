import type { FastifyReply, FastifyRequest } from "fastify";

export const createRequireApiKey =
  (apiKey: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    // Defense in depth: reject if no API key configured (should never happen - server.ts validates at startup)
    if (!apiKey) {
      return reply.code(500).send({ error: "Server misconfigured: API_KEY not set" });
    }

    const provided = request.headers["x-api-key"];
    if (typeof provided !== "string" || provided.length === 0) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    // Constant-time comparison to prevent timing attacks
    if (provided.length !== apiKey.length || !timingSafeEqual(provided, apiKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

// Constant-time string comparison
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};
