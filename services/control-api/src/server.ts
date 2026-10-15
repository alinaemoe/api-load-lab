import path from "node:path";
import Fastify from "fastify";
import websocketPlugin, { WebSocket } from "@fastify/websocket";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { LoadEngine, Toggles } from "./loadEngine";
import { Profile } from "./profiles";
import { parseTarget, publicTarget } from "./target";

const TARGET_URL = process.env.TARGET_API_URL || "http://localhost:3000";
const ROW_COUNT = Number(process.env.ROW_COUNT || 1_000_000);

const app = Fastify({ logger: false });
const sockets = new Set<WebSocket>();

function broadcast(obj: unknown) {
  const msg = JSON.stringify(obj);
  for (const sock of sockets) {
    if (sock.readyState === sock.OPEN) sock.send(msg);
  }
}

const engine = new LoadEngine({
  targetUrl: TARGET_URL,
  rowCount: ROW_COUNT,
  onTick: (tick) => broadcast(tick),
  onEvent: (event) => broadcast(event),
});

async function main() {
  await app.register(cors, { origin: true });
  await app.register(websocketPlugin);
  await app.register(staticPlugin, {
    root: path.join(__dirname, "..", "public"),
  });

  app.register(async (f) => {
    f.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({
          type: "snapshot",
          running: engine.running,
          profile: engine.profile,
          toggles: engine.toggles,
          target: publicTarget(engine.target),
        })
      );
      socket.on("close", () => sockets.delete(socket));
    });
  });

  app.get("/state", async () => ({
    running: engine.running,
    profile: engine.profile,
    toggles: engine.toggles,
    target: publicTarget(engine.target),
  }));

  app.get("/target", async () => publicTarget(engine.target));

  app.post<{ Body: unknown }>("/target", async (req, reply) => {
    if (engine.running) {
      return reply.code(409).send({ ok: false, error: "Stop the current run before changing the target" });
    }
    const parsed = parseTarget(req.body, engine.target);
    if (!parsed.ok) return reply.code(400).send({ ok: false, error: parsed.error });
    const cfg = parsed.config;
    try {
      const res = await fetch(`${TARGET_URL}/admin/upstream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          cfg.mode === "custom" && cfg.viaProxy
            ? { baseUrl: cfg.baseUrl, headers: cfg.headers, ttlSec: cfg.proxyTtlSec, concurrency: cfg.proxyConcurrency }
            : { clear: true }
        ),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`target-api answered ${res.status}`);
    } catch (err) {
      if (cfg.viaProxy) {
        return reply.code(502).send({ ok: false, error: `Lab backend (target-api) is not reachable: ${(err as Error).message}` });
      }
    }
    engine.setTarget(cfg);
    const view = publicTarget(engine.target);
    broadcast({ type: "target", target: view });
    return { ok: true, target: view };
  });

  app.post<{ Body: { profile: Profile } }>("/run/start", async (req) => {
    const profile = req.body?.profile || "spike";
    engine.stop();
    if (engine.target.mode === "lab" || engine.target.viaProxy) {
      // fresh cache/queue so back-to-back runs are comparable
      await fetch(`${TARGET_URL}/admin/reset`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      }).catch(() => undefined);
    }
    engine.start(profile);
    broadcast({ type: "state", running: true, profile });
    return { ok: true, profile: engine.profile };
  });

  app.post("/run/stop", async () => {
    engine.stop();
    broadcast({ type: "state", running: false, profile: engine.profile });
    return { ok: true };
  });

  app.post<{ Body: Partial<Toggles> }>("/toggles", async (req) => {
    const body = req.body || {};
    engine.setToggles(body);
    if (engine.target.mode === "lab" || engine.target.viaProxy) await fetch(`${TARGET_URL}/admin/toggles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    broadcast({ type: "toggles", toggles: engine.toggles });
    return { ok: true, toggles: engine.toggles };
  });

  const port = Number(process.env.PORT || 4000);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`control-api listening on :${port}`);
}

main();
