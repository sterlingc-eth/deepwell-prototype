// Shared Claude API utilities, env loading, and CORS handling
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// --- Load .env.local manually (no dotenv dependency needed) ---
// vercel dev does not reliably inject .env.local into serverless functions,
// so we read the file ourselves. Only fills in vars that aren't already set.
function loadEnvLocal() {
  const here = dirname(fileURLToPath(import.meta.url)); // .../api/_lib
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(here, "..", "..", ".env.local"), // project root relative to api/_lib
    resolve(here, "..", ".env.local"),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    return file;
  }
  return null;
}

loadEnvLocal();

export function getApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("YOUR_API_KEY")) {
    throw new Error(
      "CLAUDE_API_KEY is not set. Put CLAUDE_API_KEY=sk-ant-... in .env.local at the project root."
    );
  }
  return key;
}

/**
 * CORS headers, allow-listed — never a wildcard.
 *
 * The app calls these functions same-origin (no CORS needed at all). A browser
 * page on another origin is only allowed when its Origin is in ALLOWED_ORIGINS
 * (comma-separated), in which case that exact origin is echoed back. Pass the
 * request so the Origin header can be checked; without it (older callers) the
 * first configured origin is used, and nothing is emitted when none is set.
 */
export function handleCors(res, req) {
  const origin = allowedCorsOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  return res;
}

export function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

function allowedCorsOrigin(req) {
  const list = allowedOrigins();
  const raw = req?.headers?.origin ?? req?.headers?.Origin;
  const origin = String(Array.isArray(raw) ? raw[0] : raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
  if (!origin) return list[0] ?? null;
  return list.includes(origin) ? origin : null;
}

export function handleError(res, error) {
  console.error("API Error:", error);

  const msg = (error && error.message) || "";
  const status = error && error.status;

  if (status === 401 || msg.includes("401") || msg.includes("authentication") || msg.includes("API key") || msg.includes("CLAUDE_API_KEY")) {
    return handleCors(res).status(401).json({
      error: "Authentication failed",
      details: msg || "Check your CLAUDE_API_KEY in .env.local",
    });
  }

  if (status === 429 || msg.includes("429")) {
    return handleCors(res).status(429).json({
      error: "Rate limited",
      details: "Too many requests. Please try again in a moment.",
    });
  }

  return handleCors(res).status(500).json({
    error: "Processing failed",
    details: msg || "Unknown error",
  });
}
