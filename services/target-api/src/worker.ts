import { Worker } from "bullmq";
import IORedis from "ioredis";
import { pool } from "./db";

const connection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379",
  { maxRetriesPerRequest: null }
);
const concurrency = Number(process.env.WORKER_CONCURRENCY || 5);

new Worker(
  "lookup",
  async (job) => {
    const { sku } = job.data as { sku: string };
    const { rows } = await pool.query(
      "SELECT * FROM products WHERE sku = $1 LIMIT 1",
      [sku]
    );
    return rows[0] || null;
  },
  { connection, concurrency }
);

console.log(`worker started, concurrency=${concurrency}`);
