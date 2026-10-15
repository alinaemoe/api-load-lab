import { targetRps, shapeAt, Profile } from "./profiles";
import { TargetConfig, LAB_TARGET, expand, pickEndpoint } from "./target";

export type Toggles = {
  cache: boolean;
  queue: boolean;
  index: boolean;
  limiter: boolean;
};

type Outcome = "ok" | "hit" | "error" | "drop";
type Sample = { ms: number; outcome: Outcome; ep: number };
type EpBucket = { n: number; err: number; drop: number; ms: number[] };

type EndpointStat = { label: string; rps: number; err: number; drop: number; p95: number };

type Tick = {
  type: "tick";
  t: number;
  mode: "lab" | "custom";
  rps: number;
  err: number;
  p50: number;
  p95: number;
  p99: number;
  hitRatio: number;
  dropRate: number;
  inFlight: number;
  queueDepth: number;
  queueActive: number;
  cost: number;
  breakdown: Record<string, number>;
  endpoints: EndpointStat[];
  toggles: Toggles;
};

type Event = { type: "event"; outcome: Outcome; ms: number };

export class LoadEngine {
  running = false;
  t = 0;
  profile: Profile = "spike";
  toggles: Toggles = { cache: true, queue: false, index: false, limiter: true };
  target: TargetConfig = { ...LAB_TARGET };

  private targetUrl: string;
  private rowCount: number;
  private hotSet: string[] = [];
  private customHot: number[] = [];
  private inFlight = 0;
  private runId = 0;
  private aborters = new Set<AbortController>();
  private maxConcurrency = 150;
  private spawnAcc = 0;
  private startedAt = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  private secHandle: NodeJS.Timeout | null = null;
  private samples: Sample[] = [];
  private secBucket = { done: 0, err: 0, drop: 0, hit: 0 };
  private secEp: EpBucket[] = [];
  private eventCount = 0;
  private eventCap = 120;
  private onTick: (tick: Tick) => void;
  private onEvent: (event: Event) => void;

  constructor(opts: {
    targetUrl: string;
    rowCount: number;
    onTick: (tick: Tick) => void;
    onEvent: (event: Event) => void;
  }) {
    this.targetUrl = opts.targetUrl;
    this.rowCount = opts.rowCount;
    this.onTick = opts.onTick;
    this.onEvent = opts.onEvent;
    for (let i = 0; i < 200; i++) {
      this.hotSet.push(this.skuFor(1 + Math.floor(Math.random() * this.rowCount)));
    }
  }

  private skuFor(id: number) {
    return "SKU-" + String(id).padStart(7, "0");
  }

  private pickSku() {
    if (Math.random() < 0.8) {
      return this.hotSet[Math.floor(Math.random() * this.hotSet.length)];
    }
    return this.skuFor(1 + Math.floor(Math.random() * this.rowCount));
  }

  private randomId() {
    const { idMin, idMax } = this.target;
    return idMin + Math.floor(Math.random() * (idMax - idMin + 1));
  }

  private pickId() {
    if (this.customHot.length && Math.random() < this.target.hotRatio) {
      return this.customHot[Math.floor(Math.random() * this.customHot.length)];
    }
    return this.randomId();
  }

  setTarget(cfg: TargetConfig) {
    this.target = cfg;
    this.customHot = [];
    if (cfg.mode === "custom") {
      for (let i = 0; i < 200; i++) this.customHot.push(this.randomId());
    }
  }

  start(profile: Profile) {
    this.profile = profile;
    this.running = true;
    this.runId++;
    this.inFlight = 0;
    this.t = 0;
    this.spawnAcc = 0;
    this.maxConcurrency = this.target.mode === "custom" ? 100 : 150;
    this.startedAt = Date.now();
    this.samples = [];
    this.secEp = [];
    this.loopTick();
    this.secHandle = setInterval(() => this.flushSecond(), 1000);
  }

  stop() {
    this.running = false;
    // cut off requests still in flight so they can't leak into the next run
    this.aborters.forEach((a) => a.abort());
    this.aborters.clear();
    if (this.loopHandle) clearTimeout(this.loopHandle);
    if (this.secHandle) clearInterval(this.secHandle);
  }

  setToggles(partial: Partial<Toggles>) {
    this.toggles = { ...this.toggles, ...partial };
  }

  private currentRps() {
    return this.target.mode === "custom"
      ? shapeAt(this.profile, this.t) * this.target.peakRps
      : targetRps(this.profile, this.t);
  }

  private loopTick = () => {
    if (!this.running) return;
    this.t = (Date.now() - this.startedAt) / 1000;
    this.spawnAcc += this.currentRps() * 0.05;
    let guard = 0;
    while (this.spawnAcc >= 1 && guard < 20 && this.inFlight < this.maxConcurrency) {
      this.spawnAcc -= 1;
      this.fireRequest();
      guard++;
    }
    this.loopHandle = setTimeout(this.loopTick, 50);
  };

  private buildRequest(): { url: string; init: RequestInit; ep: number } {
    if (this.target.mode === "lab") {
      return { url: `${this.targetUrl}/products/${this.pickSku()}`, init: {}, ep: 0 };
    }
    const cfg = this.target;
    const ep = pickEndpoint(cfg.endpoints);
    const e = cfg.endpoints[ep];
    const id = this.pickId();
    if (cfg.viaProxy) {
      // upstream URL and headers live in target-api; we only send the path
      return {
        url: `${this.targetUrl}/proxy${expand(e.path, id)}`,
        init: { signal: AbortSignal.timeout(cfg.timeoutMs) },
        ep,
      };
    }
    const headers: Record<string, string> = { ...cfg.headers };
    const hasBody = e.body !== "" && e.method !== "GET" && e.method !== "HEAD";
    if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    return {
      url: cfg.baseUrl + expand(e.path, id),
      init: {
        method: e.method,
        headers,
        body: hasBody ? expand(e.body, id) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      },
      ep,
    };
  }

  private async fireRequest() {
    this.inFlight++;
    const runId = this.runId;
    const { url, init: baseInit, ep } = this.buildRequest();
    const ctrl = new AbortController();
    this.aborters.add(ctrl);
    const init: RequestInit = {
      ...baseInit,
      signal: baseInit.signal ? AbortSignal.any([baseInit.signal, ctrl.signal]) : ctrl.signal,
    };
    const t0 = performance.now();
    try {
      const res = await fetch(url, init);
      await res.arrayBuffer().catch(() => undefined); // include the body download in the timing
      const ms = performance.now() - t0;
      if (runId !== this.runId || !this.running) return;
      if (res.status === 429) {
        this.record({ ms, outcome: "drop", ep });
      } else if (!res.ok) {
        this.record({ ms, outcome: "error", ep });
      } else {
        const hit = res.headers.get("x-cache") === "hit";
        this.record({ ms, outcome: hit ? "hit" : "ok", ep });
      }
    } catch {
      if (runId !== this.runId || !this.running) return;
      const ms = performance.now() - t0;
      this.record({ ms, outcome: "error", ep });
    } finally {
      this.aborters.delete(ctrl);
      if (runId === this.runId) this.inFlight--;
    }
  }

  private record(s: Sample) {
    this.samples.push(s);
    if (this.samples.length > 2000) this.samples.shift();
    if (s.outcome === "drop") this.secBucket.drop++;
    else if (s.outcome === "error") this.secBucket.err++;
    else {
      this.secBucket.done++;
      if (s.outcome === "hit") this.secBucket.hit++;
    }
    const b = (this.secEp[s.ep] ||= { n: 0, err: 0, drop: 0, ms: [] });
    b.n++;
    if (s.outcome === "error") b.err++;
    if (s.outcome === "drop") b.drop++;
    b.ms.push(s.ms);
    if (this.eventCount < this.eventCap) {
      this.eventCount++;
      this.onEvent({ type: "event", outcome: s.outcome, ms: s.ms });
    }
  }

  private percentile(arr: number[], p: number) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }

  private async fetchQueueStats() {
    const labLike = this.target.mode === "lab" || this.target.viaProxy;
    if (!labLike || !this.toggles.queue) return { waiting: 0, active: 0 };
    try {
      const res = await fetch(`${this.targetUrl}/admin/queue`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return (await res.json()) as { waiting: number; active: number };
    } catch {
      // target busy or unreachable — report an empty queue for this tick
    }
    return { waiting: 0, active: 0 };
  }

  private async flushSecond() {
    const bucket = this.secBucket;
    this.secBucket = { done: 0, err: 0, drop: 0, hit: 0 };
    const epBuckets = this.secEp;
    this.secEp = [];
    this.eventCount = 0;
    const q = await this.fetchQueueStats();
    const totalIn = bucket.done + bucket.err + bucket.drop;
    const latencies = this.samples.slice(-400).map((s) => s.ms);
    const p50 = this.percentile(latencies, 0.5);
    const p95 = this.percentile(latencies, 0.95);
    const p99 = this.percentile(latencies, 0.99);
    const err = totalIn ? (bucket.err / totalIn) * 100 : 0;
    const dropRate = totalIn ? (bucket.drop / totalIn) * 100 : 0;

    const custom = this.target.mode === "custom";
    let cost = 0;
    let breakdown: Record<string, number> = {};
    if (!custom) {
      // simulated infra cost model — not real billing, just a stand-in for
      // "what would the toggled components cost at this throughput"
      const compute = 2 + totalIn * 0.011;
      const cacheCost = this.toggles.cache ? 1.4 : 0;
      const queueCost = this.toggles.queue ? 2.2 : 0;
      const idxCost = this.toggles.index ? 0.6 : 0;
      const dbCost = 1.8 + this.inFlight * 0.045;
      cost = compute + cacheCost + queueCost + idxCost + dbCost;
      breakdown = { compute, cache: cacheCost, queue: queueCost, index: idxCost, database: dbCost };
    }

    const endpoints: EndpointStat[] = custom
      ? this.target.endpoints.map((e, i) => {
          const b = epBuckets[i];
          return {
            label: `${e.method} ${e.path}`,
            rps: b ? b.n : 0,
            err: b && b.n ? (b.err / b.n) * 100 : 0,
            drop: b && b.n ? (b.drop / b.n) * 100 : 0,
            p95: b ? this.percentile(b.ms, 0.95) : 0,
          };
        })
      : [];

    this.onTick({
      type: "tick",
      t: this.t,
      mode: this.target.mode,
      rps: totalIn,
      err,
      p50,
      p95,
      p99,
      hitRatio: bucket.done ? bucket.hit / bucket.done : 0,
      dropRate,
      inFlight: this.inFlight,
      queueDepth: q.waiting,
      queueActive: q.active,
      cost,
      breakdown,
      endpoints,
      toggles: { ...this.toggles },
    });
  }
}
