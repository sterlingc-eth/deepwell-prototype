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

/**
 * A server misconfiguration, which is nobody's fault but ours.
 *
 * Its `message` is ALREADY the safe, user-facing text, and the real diagnostic
 * lives in `cause` where only the log can see it. That matters because two
 * different places read `error.message` and send it somewhere it should not go:
 * handleError returned it to the browser, and recordIngestFailure writes it
 * onto the document row. Making the message safe at the throw site fixes both
 * without either of them needing to know about this class.
 */
export class ConfigError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ConfigError";
    this.cause = cause;
  }
}

export function getApiKey() {
  const key = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes("YOUR_API_KEY")) {
    // Used to throw a message naming the env var and the key format, which
    // handleError's substring match then turned into 401 "Authentication
    // failed" — telling a technician in an attic that their session had
    // expired when the truth was that nobody set a server variable. They would
    // sign out and back in, forever, and it would never help.
    throw new ConfigError(
      "AI features are not configured for this environment. This is a server setting — an administrator needs to fix it.",
      "CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is unset or still a placeholder"
    );
  }
  return key;
}


/**
 * Every Anthropic call in this codebase carries an explicit timeout, and the
 * number is chosen against the PLATFORM ceiling, not the SDK's.
 *
 * THE NUMBERS HAVE TO SUM. Ingestion fetches bytes from R2 and THEN calls the
 * model, sequentially, inside one 60-second request. The first version of this
 * set them independently — 20s for R2 and 45s for the model — which adds to 65
 * seconds. Each one was individually under the ceiling and together they were
 * over it, so the slowest documents were still hard-killed by the platform with
 * no catch block, which is the exact failure both timeouts were added to
 * prevent. 10 + 35 leaves 15 seconds of headroom for everything else in the
 * request.
 *
 * The SDK defaults to roughly ten minutes. Vercel kills the function at 60
 * seconds (less, on routes that do not set maxDuration). So the SDK's timeout
 * could never fire first: a hung API call was always a hard kill, which means
 * no catch block ran, nothing was recorded, and an ingesting document was left
 * at stage 'received' with no error — indistinguishable from one still being
 * worked on. The browser then polled it for fifteen minutes and gave up.
 *
 * With a timeout below the ceiling, a hang becomes an ordinary catchable error.
 * isTransientError already classifies AbortError as transient, so it is
 * reported as retryable rather than stamped on the document as permanent.
 */
export const MODEL_TIMEOUT_MS = 35_000;

/**
 * Every client also sets `maxRetries: 0`, and that is not optional — without it
 * the timeout above does not do its job.
 *
 * The SDK defaults to maxRetries: 2, and its `timeout` is PER ATTEMPT, not a
 * deadline for the whole call. On a timeout it sleeps a backoff and tries
 * again with the same 45 seconds. Three attempts plus two backoffs is roughly
 * ninety seconds — past the 60-second ceiling, so the platform still hard-kills
 * the function and we are back to the silent, uncatchable failure this was
 * written to prevent.
 *
 * Retrying is already owned one level up: isTransientError classifies the
 * timeout as retryable, and the Inngest queue re-runs the whole step when it is
 * on. The SDK retrying underneath that is a second, invisible retry loop with
 * no knowledge of the platform's clock.
 */

/** For routes with no maxDuration of their own, which get a shorter platform default. */
export const FAST_MODEL_TIMEOUT_MS = 25_000;

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

export function handleError(res, error, req) {
  // Log the detail; return none of it. `error.message` here can carry the
  // Anthropic SDK's internals, our own config hints, or a stack fragment —
  // all of it useful to an attacker and useless to a user.
  console.error("API Error:", error);

  const msg = (error && error.message) || "";
  const status = error && error.status;

  // Before the 401 check, because a missing server key is not an auth failure
  // and must never be reported as one.
  if (error?.name === "ConfigError") {
    return handleCors(res, req).status(503).json({ error: error.message });
  }

  if (status === 401 || msg.includes("401") || msg.includes("authentication") || msg.includes("API key") || msg.includes("CLAUDE_API_KEY")) {
    return handleCors(res, req).status(401).json({ error: "Authentication failed" });
  }

  if (status === 429 || msg.includes("429")) {
    return handleCors(res, req).status(429).json({
      error: "Rate limited",
      details: "Too many requests. Please try again in a moment.",
    });
  }

  return handleCors(res, req).status(500).json({ error: "Processing failed" });
}
