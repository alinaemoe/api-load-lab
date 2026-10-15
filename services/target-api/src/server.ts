import Fastify from "fastify";
import { pool } from "./db";
import { redis } from "./redis";
import { createTokenBucket } from "./limiter";
import { lookupQueue, queueEvents } from "./queue";
import { registerProxy, proxyReset, proxyQueueCounts } from "./proxy";

type Toggles = {
  cache: boolean;
  queue: boolean;
  index: boolean;
  limiter: boolean;
};

const toggles: Toggles = {
  cache: true,
  queue: false,
  index: false,
  limiter: true,
};

const CACHE_TTL_SEC = 15;
const bucket = createTokenBucket(150, 150);

const app = Fastify({ logger: false });
registerProxy(app, { toggles, allow: () => bucket.allow() });

app.get("/healthz", async () => ({ ok: true }));

app.get("/admin/state", async () => ({ toggles }));

app.get("/admin/queue", async () => {
  const c = await lookupQueue.getJobCounts("waiting", "active", "delayed");
  const p = await proxyQueueCounts();
  return { waiting: c.waiting + c.delayed + p.waiting, active: c.active + p.active };
});

// Clean slate between comparison runs: drop cached products and queued jobs.
// Deletes by prefix instead of FLUSHDB so BullMQ's own bookkeeping survives.
app.post("/admin/reset", async () => {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "product:*", "COUNT", 500);
    cursor = next;
    if (keys.length) removed += await redis.del(...keys);
  } while (cursor !== "0");
  await lookupQueue.drain(true);
  removed += await proxyReset();
  return { ok: true, cacheKeysRemoved: removed };
});

app.post<{ Body: Partial<Toggles> }>("/admin/toggles", async (req) => {
  const body = req.body || {};
  if (typeof body.cache === "boolean") toggles.cache = body.cache;
  if (typeof body.queue === "boolean") toggles.queue = body.queue;
  if (typeof body.limiter === "boolean") toggles.limiter = body.limiter;

  if (typeof body.index === "boolean" && body.index !== toggles.index) {
    toggles.index = body.index;
    if (toggles.index) {
      await pool.query("CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku)");
    } else {
      await pool.query("DROP INDEX IF EXISTS idx_products_sku");
    }
  }

  return { toggles };
});

async function lookup(sku: string) {
  if (toggles.queue) {
    const job = await lookupQueue.add(
      "lookup",
      { sku },
      { removeOnComplete: 100, removeOnFail: 100 }
    );
    return job.waitUntilFinished(queueEvents, 8000);
  }
  const { rows } = await pool.query(
    "SELECT * FROM products WHERE sku = $1 LIMIT 1",
    [sku]
  );
  return rows[0] || null;
}

app.get<{ Params: { sku: string } }>("/products/:sku", async (req, reply) => {
  if (toggles.limiter && !bucket.allow()) {
    return reply.code(429).send({ error: "rate_limited" });
  }

  const key = `product:${req.params.sku}`;
  if (toggles.cache) {
    const cached = await redis.get(key);
    if (cached) {
      reply.header("x-cache", "hit");
      return JSON.parse(cached);
    }
  }

  const product = await lookup(req.params.sku);
  if (!product) return reply.code(404).send({ error: "not_found" });

  if (toggles.cache) {
    await redis.set(key, JSON.stringify(product), "EX", CACHE_TTL_SEC);
  }
  reply.header("x-cache", "miss");
  return product;
});

const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => console.log(`target-api listening on :${port}`));
