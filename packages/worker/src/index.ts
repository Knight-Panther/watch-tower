import { Queue, Worker } from "bullmq";

const connection = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const queue = new Queue("watchtower", { connection });

new Worker(
  "watchtower",
  async (job) => {
    console.log(`Processing job ${job.name} (${job.id})`);
  },
  { connection }
);

queue.add("startup", { startedAt: new Date().toISOString() });
