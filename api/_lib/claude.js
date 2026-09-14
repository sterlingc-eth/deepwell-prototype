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

const ALLOWED_ORIGINS = [
  "https://deepwellinc.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
];

export function handleCors(res, req) {
  // An allowlist, not "*". With credentials in play, "*" would let any site on
  // the internet call these endpoints from a signed-in user's browser.
  const origin = req?.headers?.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
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
