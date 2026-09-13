// Request guard for /api/ask — the thing standing between the public internet
// and our Claude bill. Every check here runs BEFORE any model call.
//
//   ASK_ENABLED             must be exactly "true"; anything else → 403. Default OFF.
//   ALLOWED_ORIGINS         comma-separated list of origins. A request whose Origin
//                           header is not in the list → 403. When unset, only
//                           same-host origins (Origin host === Host header) and
//                           localhost are accepted. Requests with NO Origin header
//                           (curl, server-to-server, the eval script) are allowed —
//                           browsers always send Origin on a cross-site or
//                           same-origin POST, so the app's own fetches are covered
//                           by the list; the rate limits below cover everything else.
//   ASK_PER_IP_PER_MINUTE   token bucket per client IP (default 10) → 429 + Retry-After.
//   ASK_DAILY_CAP           global Claude calls per UTC day (default 500) → 429.
//
// Storage: an in-memory Map by default. That is fine on a warm lambda but resets
// on every cold start (and is per-instance), so a determined caller could exceed
// the caps by spreading requests across instances. Set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN to move the counters to Upstash (plain fetch, no SDK)
// so limits survive cold starts. In Upstash mode the per-IP limit is a fixed
// one-minute window rather than a token bucket.

const MAX_BODY_BYTES = 512 * 1024;
const INGEST_MAX_BODY_BYTES = 8 * 1024 * 1024; // one page image, per docs/INGEST_API.md

const memory = {
  buckets: new Map(), // ip → { tokens, updatedAt }
  daily: new Map(), // 'YYYY-MM-DD' → count
  windows: new Map(), // 'ip|minute' → count  (only used when Upstash is unreachable)
  ingestBuckets: new Map(), // ip → { tokens, updatedAt } — separate pool from `buckets` so /api/ingest/* traffic can't starve /api/ask's per-IP budget
  ingestDailyPages: new Map(), // 'YYYY-MM-DD' → page count
};

export function resetGuardForTests() {
  memory.buckets.clear();
  memory.daily.clear();
  memory.windows.clear();
  memory.ingestBuckets.clear();
  memory.ingestDailyPages.clear();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function guardConfig() {
  return {
    enabled: process.env.ASK_ENABLED === "true",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map(normalizeOrigin)
      .filter(Boolean),
    perIpPerMinute: intEnv("ASK_PER_IP_PER_MINUTE", 10),
    dailyCap: intEnv("ASK_DAILY_CAP", 500),
    upstash:
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? { url: process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ""), token: process.env.UPSTASH_REDIS_REST_TOKEN }
        : null,
  };
}

function normalizeOrigin(o) {
  return String(o ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

function header(req, name) {
  const h = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : h;
}

/** First hop of x-forwarded-for, else the socket address. */
export function clientIp(req) {
  const xff = header(req, "x-forwarded-for");
  if (xff) {
    const first = String(xff).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

/** Bytes in the request body: Content-Length when present, else the serialised body. */
export function bodyBytes(req) {
  const cl = Number.parseInt(header(req, "content-length") ?? "", 10);
  if (Number.isFinite(cl) && cl >= 0) return cl;
  const b = req.body;
  if (b === undefined || b === null) return 0;
  if (typeof b === "string") return Buffer.byteLength(b);
  if (Buffer.isBuffer(b)) return b.length;
  try {
    return Buffer.byteLength(JSON.stringify(b));
  } catch {
    return 0;
  }
}

export function originAllowed(req, cfg = guardConfig()) {
  const origin = normalizeOrigin(header(req, "origin"));
  if (!origin) return true; // no Origin header: not a browser page → rate limits apply
  if (cfg.allowedOrigins.length) return cfg.allowedOrigins.includes(origin);
  let host = "";
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const reqHost = String(header(req, "x-forwarded-host") ?? header(req, "host") ?? "").toLowerCase();
  if (host && host === reqHost) return true;
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

async function upstash(cfg, commands) {
  const res = await fetch(`${cfg.upstash.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.upstash.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  const out = await res.json();
  return out.map((r) => r.result);
}

/** Per-IP limit. Returns { allowed, retryAfter } and consumes a token when allowed. */
async function takeIpToken(ip, cfg, now) {
  const limit = cfg.perIpPerMinute;
  if (limit <= 0) return { allowed: false, retryAfter: 60 };

  if (cfg.upstash) {
    const minute = Math.floor(now / 60000);
    const key = `ask:ip:${ip}:${minute}`;
    try {
      const [count] = await upstash(cfg, [["INCR", key], ["EXPIRE", key, 120]]);
      if (Number(count) <= limit) return { allowed: true };
      return { allowed: false, retryAfter: Math.max(1, 60 - Math.floor((now % 60000) / 1000)) };
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "ip", message: String(err?.message ?? err) }));
      // fall through to memory
    }
  }

  const rate = limit / 60000; // tokens per ms
  const b = memory.buckets.get(ip) ?? { tokens: limit, updatedAt: now };
  b.tokens = Math.min(limit, b.tokens + (now - b.updatedAt) * rate);
  b.updatedAt = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    memory.buckets.set(ip, b);
    if (memory.buckets.size > 5000) pruneBuckets(now);
    return { allowed: true };
  }
  memory.buckets.set(ip, b);
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
}

function pruneBuckets(now) {
  for (const [ip, b] of memory.buckets) if (now - b.updatedAt > 120000) memory.buckets.delete(ip);
}

/** Read-only: how many Claude calls have started today. */
async function dailyCount(cfg, now) {
  const day = utcDay(now);
  if (cfg.upstash) {
    try {
      const [n] = await upstash(cfg, [["GET", `ask:daily:${day}`]]);
      return Number(n ?? 0);
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "daily-get", message: String(err?.message ?? err) }));
    }
  }
  return memory.daily.get(day) ?? 0;
}

/**
 * Call this right before a Claude call starts. Increments the daily counter and
 * returns { ok:true, count } or { ok:false, status:429, body, headers } when the
 * increment lands past the cap.
 */
export async function reserveClaudeCall(now = Date.now()) {
  const cfg = guardConfig();
  const day = utcDay(now);
  let count;
  if (cfg.upstash) {
    try {
      const [n] = await upstash(cfg, [["INCR", `ask:daily:${day}`], ["EXPIRE", `ask:daily:${day}`, 172800]]);
      count = Number(n);
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "daily-incr", message: String(err?.message ?? err) }));
    }
  }
  if (count === undefined) {
    count = (memory.daily.get(day) ?? 0) + 1;
    memory.daily.set(day, count);
    for (const k of memory.daily.keys()) if (k !== day) memory.daily.delete(k);
  }
  if (count > cfg.dailyCap) {
    console.warn(JSON.stringify({ guard: "daily-cap-reached", day, count, cap: cfg.dailyCap }));
    return dailyCapResponse(now);
  }
  return { ok: true, count };
}

function secondsToUtcMidnight(now) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function dailyCapResponse(now) {
  const retryAfter = secondsToUtcMidnight(now);
  return {
    ok: false,
    status: 429,
    body: { error: "Too many questions", retryAfter },
    headers: { "Retry-After": String(retryAfter) },
  };
}

// ---------------------------------------------------------------------------
// Ingest guard — /api/ingest/read and /api/ingest/map (docs/INGEST_API.md)
//
// Same building blocks as the ask guard above (origin allow-list, token-bucket
// per-IP limiting, Upstash-or-memory counters) plus two differences:
//   - a separate INGEST_ENABLED flag (default off, independent of ASK_ENABLED)
//   - a global daily PAGE cap (INGEST_DAILY_PAGES, default 300) instead of a
//     call cap — incremented by the caller's page count, not by 1 per request,
//     so a single request that reserves N pages consumes N of the day's budget
//   - its own per-IP token bucket, kept separate from the ask bucket above, so
//     heavy ingestion traffic from one IP cannot starve that IP's /api/ask
//     budget (or vice versa) — same ASK_PER_IP_PER_MINUTE limit, own counter.
// ---------------------------------------------------------------------------

export function ingestGuardConfig() {
  const base = guardConfig();
  return {
    ...base,
    ingestEnabled: process.env.INGEST_ENABLED === "true",
    dailyPageCap: intEnv("INGEST_DAILY_PAGES", 300),
  };
}

/** Per-IP limit for ingest traffic — same algorithm/limit as takeIpToken, separate counter pool. */
async function takeIngestIpToken(ip, cfg, now) {
  const limit = cfg.perIpPerMinute;
  if (limit <= 0) return { allowed: false, retryAfter: 60 };

  if (cfg.upstash) {
    const minute = Math.floor(now / 60000);
    const key = `ingest:ip:${ip}:${minute}`;
    try {
      const [count] = await upstash(cfg, [["INCR", key], ["EXPIRE", key, 120]]);
      if (Number(count) <= limit) return { allowed: true };
      return { allowed: false, retryAfter: Math.max(1, 60 - Math.floor((now % 60000) / 1000)) };
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "ingest-ip", message: String(err?.message ?? err) }));
      // fall through to memory
    }
  }

  const rate = limit / 60000; // tokens per ms
  const b = memory.ingestBuckets.get(ip) ?? { tokens: limit, updatedAt: now };
  b.tokens = Math.min(limit, b.tokens + (now - b.updatedAt) * rate);
  b.updatedAt = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    memory.ingestBuckets.set(ip, b);
    if (memory.ingestBuckets.size > 5000) pruneIngestBuckets(now);
    return { allowed: true };
  }
  memory.ingestBuckets.set(ip, b);
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
}

function pruneIngestBuckets(now) {
  for (const [ip, b] of memory.ingestBuckets) if (now - b.updatedAt > 120000) memory.ingestBuckets.delete(ip);
}

/** Read-only: how many pages have been reserved today. */
async function dailyPagesCount(cfg, now) {
  const day = utcDay(now);
  if (cfg.upstash) {
    try {
      const [n] = await upstash(cfg, [["GET", `ingest:daily-pages:${day}`]]);
      return Number(n ?? 0);
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "ingest-daily-get", message: String(err?.message ?? err) }));
    }
  }
  return memory.ingestDailyPages.get(day) ?? 0;
}

/**
 * Call this right before a page-reading Claude call starts (once per page —
 * `pages` is normally 1). Increments the daily page counter and returns
 * { ok:true, count } or { ok:false, status:429, body, headers } when the
 * increment lands past INGEST_DAILY_PAGES. Endpoints that don't read a page
 * image (e.g. /api/ingest/map) should pass pages:0 and skip this reservation
 * entirely — the page cap only meters the vision pass.
 */
export async function reserveIngestPages(pages = 1, now = Date.now()) {
  const cfg = ingestGuardConfig();
  if (pages <= 0) return { ok: true, count: await dailyPagesCount(cfg, now) };
  const day = utcDay(now);
  let count;
  if (cfg.upstash) {
    try {
      const [n] = await upstash(cfg, [["INCRBY", `ingest:daily-pages:${day}`, pages], ["EXPIRE", `ingest:daily-pages:${day}`, 172800]]);
      count = Number(n);
    } catch (err) {
      console.error(JSON.stringify({ guard: "upstash-error", op: "ingest-daily-incr", message: String(err?.message ?? err) }));
    }
  }
  if (count === undefined) {
    count = (memory.ingestDailyPages.get(day) ?? 0) + pages;
    memory.ingestDailyPages.set(day, count);
    for (const k of memory.ingestDailyPages.keys()) if (k !== day) memory.ingestDailyPages.delete(k);
  }
  if (count > cfg.dailyPageCap) {
    console.warn(JSON.stringify({ guard: "ingest-daily-cap-reached", day, count, cap: cfg.dailyPageCap }));
    return dailyCapResponse(now);
  }
  return { ok: true, count };
}

/**
 * checkIngestGuard(req, opts) → { ok:true, ip } | { ok:false, status, body, headers }
 * Order: INGEST_ENABLED → origin → body size (default 8 MB, one page image) →
 * per-IP bucket (separate pool from /api/ask) → daily page cap (read-only;
 * pass opts.pages to pre-check a specific request's cost, default 1). The
 * daily page counter itself is incremented by reserveIngestPages() right
 * before the model call, mirroring reserveClaudeCall()'s race-safe pattern.
 */
export async function checkIngestGuard(req, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxBodyBytes = opts.maxBodyBytes ?? INGEST_MAX_BODY_BYTES;
  const pages = opts.pages ?? 1;
  const cfg = ingestGuardConfig();
  const ip = clientIp(req);

  if (!cfg.ingestEnabled) {
    return { ok: false, status: 403, body: { error: "Ingestion service is disabled" }, headers: {} };
  }
  if (!originAllowed(req, cfg)) {
    return { ok: false, status: 403, body: { error: "Origin not allowed" }, headers: {} };
  }
  if (bodyBytes(req) > maxBodyBytes) {
    return { ok: false, status: 413, body: { error: "Request body too large" }, headers: {} };
  }

  const bucket = await takeIngestIpToken(ip, cfg, now);
  if (!bucket.allowed) {
    const retryAfter = bucket.retryAfter ?? 60;
    return {
      ok: false,
      status: 429,
      body: { error: "Too many requests", retryAfter },
      headers: { "Retry-After": String(retryAfter) },
    };
  }

  if (pages > 0 && (await dailyPagesCount(cfg, now)) + pages > cfg.dailyPageCap) {
    console.warn(JSON.stringify({ guard: "ingest-daily-cap-reached", day: utcDay(now), cap: cfg.dailyPageCap, ip }));
    return dailyCapResponse(now);
  }

  return { ok: true, ip };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * checkGuard(req) → { ok:true, ip } | { ok:false, status, body, headers }
 * Order: enabled → origin → body size → per-IP bucket → daily cap (read-only).
 * The daily counter itself is incremented by reserveClaudeCall().
 */
export async function checkGuard(req, opts = {}) {
  const now = opts.now ?? Date.now();
  const cfg = guardConfig();
  const ip = clientIp(req);

  if (!cfg.enabled) {
    return { ok: false, status: 403, body: { error: "Answer service is disabled" }, headers: {} };
  }
  if (!originAllowed(req, cfg)) {
    return { ok: false, status: 403, body: { error: "Origin not allowed" }, headers: {} };
  }
  if (bodyBytes(req) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, body: { error: "Request body too large" }, headers: {} };
  }

  const bucket = await takeIpToken(ip, cfg, now);
  if (!bucket.allowed) {
    const retryAfter = bucket.retryAfter ?? 60;
    return {
      ok: false,
      status: 429,
      body: { error: "Too many questions", retryAfter },
      headers: { "Retry-After": String(retryAfter) },
    };
  }

  if ((await dailyCount(cfg, now)) >= cfg.dailyCap) {
    console.warn(JSON.stringify({ guard: "daily-cap-reached", day: utcDay(now), cap: cfg.dailyCap, ip }));
    return dailyCapResponse(now);
  }

  return { ok: true, ip };
}

export { MAX_BODY_BYTES, INGEST_MAX_BODY_BYTES };
