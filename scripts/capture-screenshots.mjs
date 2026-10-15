// Regenerates the README screenshots from the running stack (docker compose up).
//   node scripts/capture-screenshots.mjs
// Needs Chrome/Edge installed (CHROME_PATH overrides) and Node 22+ (global WebSocket).
// It drives the real UI through Chrome DevTools Protocol, so the images show real runs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:4000";
const OUT = path.resolve("docs/screenshots");
const PORT = 9333;
const WIDTH = 1440;
const HEIGHT = 900;
const DEFAULT_TOGGLES = { cache: true, limiter: true, queue: false, index: false };

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("No Chrome/Edge found - set CHROME_PATH");

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // e.g. ONLY=proxy,queue
const want = (name) => !ONLY || ONLY.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const res = await fetch(BASE + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

mkdirSync(OUT, { recursive: true });
const profileDir = mkdtempSync(path.join(tmpdir(), "alab-shots-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--disable-gpu",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(500);
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

const ws = new WebSocket(await cdpTarget());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else {
    listeners.forEach((l) => l(msg));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
  return r.result.value;
}

async function load() {
  // each scene starts without a ghost left over from an earlier one
  await ev("try{localStorage.removeItem('apiLoadLab.ghostA')}catch(e){} 1").catch(() => undefined);
  const loaded = new Promise((resolve) => {
    const l = (msg) => {
      if (msg.method === "Page.loadEventFired") {
        listeners.delete(l);
        resolve();
      }
    };
    listeners.add(l);
  });
  await send("Page.navigate", { url: BASE });
  await loaded;
  await sleep(800);
}

async function shot(name) {
  await sleep(400);
  const { cssContentSize } = await send("Page.getLayoutMetrics");
  const clip = { x: 0, y: 0, width: WIDTH, height: Math.ceil(cssContentSize.height), scale: 1 };
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
  writeFileSync(path.join(OUT, name + ".png"), Buffer.from(data, "base64"));
  console.log("saved", name + ".png");
}

const startRun = (profile) =>
  ev(`document.getElementById('profileSelect').value='${profile}'; document.getElementById('playBtn').click(); 1`);
const stopRun = () => api("/run/stop", {});

async function resetStack() {
  await stopRun();
  await api("/target", { mode: "lab" });
  await api("/toggles", DEFAULT_TOGGLES);
}

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1.5,
    mobile: false,
  });

  if (want("lab")) {
    // 1. lab, live run with cache on
    await resetStack();
    await load();
    await startRun("spike");
    await sleep(21000);
    await shot("lab-live");
    await stopRun();
  }

  if (want("race")) {
    // 2. race mode: bare run saved as ghost A, then cache + index as live run B
    await resetStack();
    await api("/toggles", { cache: false, limiter: false, queue: false, index: false });
    await load();
    await startRun("spike");
    await sleep(24000);
    await ev("document.getElementById('saveABtn').click(); 1");
    await stopRun();
    await sleep(500);
    await api("/toggles", { cache: true, limiter: true, queue: false, index: true });
    await sleep(500);
    await startRun("spike");
    await sleep(24000);
    await shot("race-ab");
    await stopRun();
    await sleep(800);
    await ev(`(function(){
      var tl=document.getElementById('timeline'), r=tl.getBoundingClientRect();
      function e(t){ tl.dispatchEvent(new PointerEvent(t,{clientX:r.left+r.width*0.78,clientY:r.top+4,pointerId:1,bubbles:true})); }
      e('pointerdown'); e('pointerup'); return 1; })()`);
    await shot("scrubber");
  }

  if (want("queue")) {
    // 3. queue backlog under stress
    await resetStack();
    await api("/toggles", { cache: false, limiter: false, queue: true, index: false });
    await load();
    await startRun("stress");
    await sleep(50000);
    await shot("queue-backlog");
    await stopRun();
  }

  if (want("custom")) {
    // 4. custom endpoints
    await resetStack();
    await api("/target", {
      mode: "custom",
      baseUrl: "http://target-api:3000",
      endpoints: [
        { method: "GET", path: "/products/SKU-{id:7}", weight: 8 },
        { method: "GET", path: "/healthz", weight: 2 },
        { method: "GET", path: "/no-such-route", weight: 1 },
      ],
      peakRps: 80,
    });
    await load();
    await ev("document.getElementById('targetCard').open=true; 1");
    await startRun("constant");
    await sleep(14000);
    await shot("custom-target");
    await stopRun();
  }

  if (want("proxy")) {
    // 5. lab proxy in front of a slow upstream: cache switched on mid-run
    await resetStack();
    await api("/target", {
      mode: "custom",
      baseUrl: "http://target-api:3000",
      endpoints: [{ method: "GET", path: "/demo/slow?ms=250&k={id}", weight: 1 }],
      idMin: 1,
      idMax: 50,
      hotRatio: 0.8,
      peakRps: 60,
      viaProxy: true,
      proxyTtlSec: 30,
      proxyConcurrency: 5,
    });
    await api("/toggles", { cache: false, queue: false, limiter: false });
    await load();
    await startRun("constant");
    await sleep(10000);
    await api("/toggles", { cache: true });
    await sleep(11000);
    await shot("proxy");
    await stopRun();
  }
} finally {
  await resetStack().catch(() => undefined);
  ws.close();
  chrome.kill();
}
