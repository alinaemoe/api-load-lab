import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379",
  { maxRetriesPerRequest: null }
);

export const lookupQueue = new Queue("lookup", { connection });
export const queueEvents = new QueueEvents("lookup", { connection });
