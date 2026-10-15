import type { FastifyInstance } from "fastify";
import { Worker } from "bullmq";
import { connection, proxyQueue, proxyEvents } from "./queue";
import { redis } from "./redis";

// Lab proxy: forwards GET requests to an upstream API through the same switchable
// pieces as the built-in lab (rate limiter -> Redis cache -> optional queue with a
// bounded number of workers). Lets you ask "what if this API had X in front of it?"
// with real measurements.

type Upstream = {
  baseUrl: string;
  headers: Record<string, string>;
  ttlSec: number;
  concurrency: number;
  version: number;
};

type Stored = { status: number; type: string; body: string; truncated?: boolean };

const MAX_BODY_BYTES = 1_048_576;
const UPSTREAM_TIMEOUT_MS = 10_000;

let upstream: Upstream | null = null;
let worker: Worker | null = null;
let version = 0;

async function fetchUpstream(path: string): Promise<Stored> {
  const up = upstream;
  if (!up) throw new Error("no_upstream");
  const res = await fetch(up.baseUrl + path, {
    headers: up.headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "application/octet-stream";
  if (buf.length > MAX_BODY_BYTES) return { status: res.status, type, body: "", truncated: true };
  return { status: res.status, type, body: buf.toString("base64") };
}

async function startWorker(concurrency: number) {
  if (worker) await worker.close();
  worker = new Worker("proxy", async (job) => fetchUpstream(job.data.path), {
    connection,
    concurrency,
  });
  worker.on("error", () => undefined);
}

function validBase(raw: unknown): string | null {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname.startsWith("169.254.") || u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export async function proxyReset(): Promise<number> {
  let removed = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "proxy:*", "COUNT", 500);
    cursor = next;
    if (keys.length) removed += await redis.del(...keys);
  } while (cursor !== "0");
  await proxyQueue.drain(true);
  return removed;
}

export async function proxyQueueCounts() {
  const c = await proxyQueue.getJobCounts("waiting", "active", "delayed");
  return { waiting: c.waiting + c.delayed, active: c.active };
}

export function registerProxy(
  app: FastifyInstance,
  ctx: { toggles: { cache: boolean; queue: boolean; limiter: boolean }; allow: () => boolean }
) {
  app.post<{ Body: any }>("/admin/upstream", async (req, reply) => {
    const body: any = req.body || {};
    if (body.clear) {
      upstream = null;
      if (worker) await worker.close();
      worker = null;
      return { ok: true, cleared: true };
    }
    const baseUrl = validBase(body.baseUrl);
    if (!baseUrl) return reply.code(400).send({ ok: false, error: "invalid baseUrl" });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers || {})) headers[k] = String(v);
    const ttlSec = Math.min(3600, Math.max(1, Math.floor(Number(body.ttlSec) || 15)));
    const concurrency = Math.min(50, Math.max(1, Math.floor(Number(body.concurrency) || 5)));
    upstream = { baseUrl, headers, ttlSec, concurrency, version: ++version };
    await startWorker(concurrency);
    return { ok: true, ttlSec, concurrency };
  });

  app.get("/proxy/*", async (req, reply) => {
    const up = upstream;
    if (!up) return reply.code(503).send({ error: "no_upstream" });
    if (ctx.toggles.limiter && !ctx.allow()) return reply.code(429).send({ error: "rate_limited" });

    const path = req.url.slice("/proxy".length);
    const key = `proxy:${up.version}:${path}`;

    const send = (out: Stored, cache: "hit" | "miss") => {
      reply.header("x-cache", cache).code(out.status).header("content-type", out.type);
      return reply.send(Buffer.from(out.body, "base64"));
    };

    if (ctx.toggles.cache) {
      const cached = await redis.get(key);
      if (cached) return send(JSON.parse(cached) as Stored, "hit");
    }

    let out: Stored;
    try {
      if (ctx.toggles.queue) {
        const job = await proxyQueue.add("fetch", { path }, { removeOnComplete: 100, removeOnFail: 100 });
        out = (await job.waitUntilFinished(proxyEvents, 30_000)) as Stored;
      } else {
        out = await fetchUpstream(path);
      }
    } catch {
      return reply.code(502).send({ error: "upstream_failed" });
    }

    if (ctx.toggles.cache && out.status >= 200 && out.status < 300) {
      await redis.set(key, JSON.stringify(out), "EX", up.ttlSec);
    }
    return send(out, "miss");
  });

  // A deliberately slow upstream so the proxy demo has something to speed up.
  app.get<{ Querystring: { ms?: string } }>("/demo/slow", async (req) => {
    const base = Math.min(5000, Math.max(0, Number(req.query.ms) || 250));
    await new Promise((r) => setTimeout(r, base * (0.85 + Math.random() * 0.3)));
    return { ok: true, waitedMs: Math.round(base), at: new Date().toISOString() };
  });
}
