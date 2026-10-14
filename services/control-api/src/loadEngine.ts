import { targetRps, Profile } from "./profiles";

export type Toggles = {
  cache: boolean;
  queue: boolean;
  index: boolean;
  limiter: boolean;
};

type Outcome = "ok" | "hit" | "error" | "drop";
type Sample = { ms: number; outcome: Outcome };

type Tick = {
  type: "tick";
  t: number;
  rps: number;
  err: number;
  p50: number;
  p95: number;
  p99: number;
  hitRatio: number;
  dropRate: number;
  inFlight: number;
  cost: number;
  breakdown: Record<string, number>;
  toggles: Toggles;
};

type Event = { type: "event"; outcome: Outcome; ms: number };

export class LoadEngine {
  running = false;
  t = 0;
  profile: Profile = "spike";
  toggles: Toggles = { cache: true, queue: false, index: false, limiter: true };

  private targetUrl: string;
  private rowCount: number;
  private hotSet: string[] = [];
  private inFlight = 0;
  private maxConcurrency = 150;
  private spawnAcc = 0;
  private startedAt = 0;
  private loopHandle: NodeJS.Timeout | null = null;
  private secHandle: NodeJS.Timeout | null = null;
  private samples: Sample[] = [];
  private secBucket = { done: 0, err: 0, drop: 0, hit: 0 };
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

  start(profile: Profile) {
    this.profile = profile;
    this.running = true;
    this.t = 0;
    this.spawnAcc = 0;
    this.startedAt = Date.now();
    this.loopTick();
    this.secHandle = setInterval(() => this.flushSecond(), 1000);
  }

  stop() {
    this.running = false;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    if (this.secHandle) clearInterval(this.secHandle);
  }

  setToggles(partial: Partial<Toggles>) {
    this.toggles = { ...this.toggles, ...partial };
  }

  private loopTick = () => {
    if (!this.running) return;
    this.t = (Date.now() - this.startedAt) / 1000;
    const tr = targetRps(this.profile, this.t);
    this.spawnAcc += tr * 0.05;
    let guard = 0;
    while (this.spawnAcc >= 1 && guard < 20 && this.inFlight < this.maxConcurrency) {
      this.spawnAcc -= 1;
      this.fireRequest();
      guard++;
    }
    this.loopHandle = setTimeout(this.loopTick, 50);
  };

  private async fireRequest() {
    this.inFlight++;
    const sku = this.pickSku();
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.targetUrl}/products/${sku}`);
      const ms = performance.now() - t0;
      if (res.status === 429) {
        this.record({ ms, outcome: "drop" });
      } else if (!res.ok) {
        this.record({ ms, outcome: "error" });
      } else {
        const hit = res.headers.get("x-cache") === "hit";
        this.record({ ms, outcome: hit ? "hit" : "ok" });
      }
    } catch {
      const ms = performance.now() - t0;
      this.record({ ms, outcome: "error" });
    } finally {
      this.inFlight--;
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

  private flushSecond() {
    const totalIn = this.secBucket.done + this.secBucket.err + this.secBucket.drop;
    const latencies = this.samples.slice(-400).map((s) => s.ms);
    const p50 = this.percentile(latencies, 0.5);
    const p95 = this.percentile(latencies, 0.95);
    const p99 = this.percentile(latencies, 0.99);
    const err = totalIn ? (this.secBucket.err / totalIn) * 100 : 0;
    const dropRate = totalIn ? (this.secBucket.drop / totalIn) * 100 : 0;

    // simulated infra cost model — not real billing, just a stand-in for
    // "what would the toggled components cost at this throughput"
    const compute = 2 + totalIn * 0.011;
    const cacheCost = this.toggles.cache ? 1.4 : 0;
    const queueCost = this.toggles.queue ? 2.2 : 0;
    const idxCost = this.toggles.index ? 0.6 : 0;
    const dbCost = 1.8 + this.inFlight * 0.045;
    const cost = compute + cacheCost + queueCost + idxCost + dbCost;

    this.onTick({
      type: "tick",
      t: this.t,
      rps: totalIn,
      err,
      p50,
      p95,
      p99,
      hitRatio: this.secBucket.done ? this.secBucket.hit / this.secBucket.done : 0,
      dropRate,
      inFlight: this.inFlight,
      cost,
      breakdown: { compute, cache: cacheCost, queue: queueCost, index: idxCost, database: dbCost },
      toggles: { ...this.toggles },
    });

    this.secBucket = { done: 0, err: 0, drop: 0, hit: 0 };
    this.eventCount = 0;
  }
}
