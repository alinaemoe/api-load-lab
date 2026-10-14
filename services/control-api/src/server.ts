import path from "node:path";
import Fastify from "fastify";
import websocketPlugin, { WebSocket } from "@fastify/websocket";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { LoadEngine, Toggles } from "./loadEngine";
import { Profile } from "./profiles";

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
        })
      );
      socket.on("close", () => sockets.delete(socket));
    });
  });

  app.get("/state", async () => ({
    running: engine.running,
    profile: engine.profile,
    toggles: engine.toggles,
  }));

  app.post<{ Body: { profile: Profile } }>("/run/start", async (req) => {
    const profile = req.body?.profile || "spike";
    engine.stop();
    // fresh cache/queue so back-to-back runs are comparable
    await fetch(`${TARGET_URL}/admin/reset`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
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
    await fetch(`${TARGET_URL}/admin/toggles`, {
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
