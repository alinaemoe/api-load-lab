import { randomUUID } from "node:crypto";

export type Endpoint = { method: string; path: string; weight: number; body: string };

export type TargetConfig = {
  mode: "lab" | "custom";
  baseUrl: string;
  endpoints: Endpoint[];
  headers: Record<string, string>;
  idMin: number;
  idMax: number;
  hotRatio: number;
  peakRps: number;
  timeoutMs: number;
  confirmed: boolean;
  viaProxy: boolean;
  proxyTtlSec: number;
  proxyConcurrency: number;
};

export const LAB_TARGET: TargetConfig = {
  mode: "lab",
  baseUrl: "",
  endpoints: [],
  headers: {},
  idMin: 1,
  idMax: 1_000_000,
  hotRatio: 0.8,
  peakRps: 50,
  timeoutMs: 10_000,
  confirmed: false,
  viaProxy: false,
  proxyTtlSec: 15,
  proxyConcurrency: 5,
};

export const LIMITS = { maxPeakRps: 300, maxEndpoints: 10, maxHeaders: 10 };

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH"]);
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (h === "host.docker.internal") return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare docker/compose service name
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export type ParseResult = { ok: true; config: TargetConfig } | { ok: false; error: string };

// `prev` supplies headers when the client omits them (header values are write-only).
export function parseTarget(raw: any, prev: TargetConfig): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  if (raw.mode === "lab") return { ok: true, config: { ...LAB_TARGET } };
  if (raw.mode !== "custom") return { ok: false, error: "mode must be 'lab' or 'custom'" };

  let url: URL;
  try {
    url = new URL(String(raw.baseUrl || ""));
  } catch {
    return { ok: false, error: "Base URL is not a valid URL (e.g. https://api.example.com)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are supported" };
  }
  if (url.hostname.startsWith("169.254.")) {
    return { ok: false, error: "Link-local addresses are not allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Put credentials in headers, not in the URL" };
  }
  const confirmed = raw.confirmed === true;
  if (!isPrivateHost(url.hostname) && !confirmed) {
    return {
      ok: false,
      error: `${url.hostname} is not a local host - tick "I own this API or have permission to load-test it"`,
    };
  }

  const eps = Array.isArray(raw.endpoints) ? raw.endpoints : [];
  if (eps.length < 1 || eps.length > LIMITS.maxEndpoints) {
    return { ok: false, error: `Add between 1 and ${LIMITS.maxEndpoints} endpoints` };
  }
  const endpoints: Endpoint[] = [];
  for (const e of eps) {
    const method = String(e?.method || "GET").toUpperCase();
    const path = String(e?.path || "");
    if (!METHODS.has(method)) return { ok: false, error: `Method ${method} is not supported` };
    if (!/^\/[^\s]*$/.test(path) || path.startsWith("//") || path.length > 300) {
      return { ok: false, error: `Path "${path}" must start with a single "/" and contain no spaces` };
    }
    const body = String(e?.body || "");
    if (body.length > 4096) return { ok: false, error: "Request body is limited to 4 KB" };
    endpoints.push({ method, path, weight: num(e?.weight, 1, 1, 100), body });
  }

  let headers = prev.headers;
  if (raw.headers && typeof raw.headers === "object") {
    headers = {};
    const names = Object.keys(raw.headers);
    if (names.length > LIMITS.maxHeaders) return { ok: false, error: `At most ${LIMITS.maxHeaders} headers` };
    for (const name of names) {
      const value = String(raw.headers[name]);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return { ok: false, error: `Bad header name "${name}"` };
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return { ok: false, error: `Header ${name} is managed automatically` };
      if (/[\r\n]/.test(value) || value.length > 2000) return { ok: false, error: `Bad value for header ${name}` };
      headers[name] = value;
    }
  }

  const idMin = Math.floor(num(raw.idMin, 1, 0, Number.MAX_SAFE_INTEGER));
  const idMax = Math.floor(num(raw.idMax, 1_000_000, 0, Number.MAX_SAFE_INTEGER));
  if (idMin > idMax) return { ok: false, error: "ID range: min must be <= max" };

  const viaProxy = raw.viaProxy === true;
  if (viaProxy && endpoints.some((e) => e.method !== "GET")) {
    return { ok: false, error: "The lab proxy supports GET endpoints only (responses are cached and replayed)" };
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  return {
    ok: true,
    config: {
      mode: "custom",
      baseUrl: `${url.origin}${basePath}`,
      endpoints,
      headers,
      idMin,
      idMax,
      hotRatio: num(raw.hotRatio, 0.8, 0, 1),
      peakRps: Math.floor(num(raw.peakRps, 50, 1, LIMITS.maxPeakRps)),
      timeoutMs: Math.floor(num(raw.timeoutMs, 10_000, 200, 30_000)),
      confirmed,
      viaProxy,
      proxyTtlSec: Math.floor(num(raw.proxyTtlSec, 15, 1, 3600)),
      proxyConcurrency: Math.floor(num(raw.proxyConcurrency, 5, 1, 50)),
    },
  };
}

export function publicTarget(t: TargetConfig) {
  const { headers, ...rest } = t;
  return { ...rest, headerNames: Object.keys(headers), limits: LIMITS };
}

// {id} -> random id (hot-set biased), {id:7} -> zero-padded, {uuid} -> random uuid
export function expand(template: string, id: number): string {
  return template
    .replace(/\{id:(\d{1,2})\}/g, (_, n) => String(id).padStart(Number(n), "0"))
    .replace(/\{id\}/g, String(id))
    .replace(/\{uuid\}/g, () => randomUUID());
}

export function pickEndpoint(endpoints: Endpoint[]): number {
  const total = endpoints.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < endpoints.length; i++) {
    r -= endpoints[i].weight;
    if (r <= 0) return i;
  }
  return endpoints.length - 1;
}
