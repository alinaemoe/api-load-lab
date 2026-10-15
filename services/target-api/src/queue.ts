import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379",
  { maxRetriesPerRequest: null }
);

export const lookupQueue = new Queue("lookup", { connection });
export const queueEvents = new QueueEvents("lookup", { connection });

// Separate queue for the lab proxy so it never mixes with the product lookups.
export const proxyQueue = new Queue("proxy", { connection });
export const proxyEvents = new QueueEvents("proxy", { connection });
