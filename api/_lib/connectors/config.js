/**
 * Storage connectors: switches, limits, wording and the NAMES of environment variables (never values).
 * EVERYTHING SHIPS OFF. DEEPWELL_CONNECTORS must be exactly "1" for any connector code to run, and each provider has its own switch
 * (DEEPWELL_CONNECTOR_GDRIVE / _DROPBOX / _ONEDRIVE / _EMAILIN). With the master unset the route answers {enabled:false} and
 * nothing else in this folder is imported.
 */
export const PROVIDER_IDS = Object.freeze(["gdrive", "dropbox", "onedrive", "emailin"]);

export const PROVIDER_FLAG = Object.freeze({
  gdrive: "DEEPWELL_CONNECTOR_GDRIVE",
  dropbox: "DEEPWELL_CONNECTOR_DROPBOX",
  onedrive: "DEEPWELL_CONNECTOR_ONEDRIVE",
  emailin: "DEEPWELL_CONNECTOR_EMAILIN",
});

/** Env var NAMES each provider needs the owner to set (values are set by the owner in Vercel, never in chat or code). */
export const PROVIDER_ENV = Object.freeze({
  gdrive: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "GOOGLE_TOKEN_KEY"],
  dropbox: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REDIRECT_URI", "CONNECTORS_TOKEN_KEY"],
  onedrive: ["MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_REDIRECT_URI", "MS_GRAPH_CLIENT_STATE", "CONNECTORS_TOKEN_KEY"],
  emailin: ["EMAILIN_DOMAIN", "EMAILIN_WEBHOOK_SECRET", "EMAILIN_ADDRESS_KEY", "RESEND_API_KEY"],
});

export const isConnectorsEnabled = (env = process.env) => String(env.DEEPWELL_CONNECTORS ?? "") === "1";
export const isProviderEnabled = (id, env = process.env) =>
  isConnectorsEnabled(env) && Object.hasOwn(PROVIDER_FLAG, id) && String(env[PROVIDER_FLAG[id]] ?? "") === "1";
export const enabledProviders = (env = process.env) => PROVIDER_IDS.filter((p) => isProviderEnabled(p, env));

/** Names of env vars that are missing for a provider (names only, so the status screen can say what is not set up). */
export const missingEnv = (id, env = process.env) => (PROVIDER_ENV[id] ?? []).filter((n) => !String(env[n] ?? "").trim());

export function limits(env = process.env) {
  const n = (k, d, lo, hi) => { const v = Number(env[k]); return Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : d; };
  return {
    maxBytesPerFile: n("CONNECTORS_MAX_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxFilesPerPass: n("CONNECTORS_MAX_FILES_PER_PASS", 60, 1, 500),
    maxPagesPerPass: n("CONNECTORS_MAX_PAGES_PER_PASS", 20, 1, 200),
    leaseMs: n("CONNECTORS_LEASE_MS", 5 * 60_000, 30_000, 15 * 60_000),
    emailMaxAttachments: n("EMAILIN_MAX_ATTACHMENTS", 10, 1, 25),
    emailMinImageBytes: n("EMAILIN_MIN_IMAGE_BYTES", 15 * 1024, 0, 1024 * 1024),
    emailPerHour: n("EMAILIN_PER_HOUR", 30, 1, 1000),
  };
}

/** Customer-visible wording. Plain language, no costs, no internals. */
export const WORDING = Object.freeze({
  adminOnly: "Only a company admin can manage connected sources.",
  notAvailable: "Not available.",
  accessLost: "DeepWell lost access to this folder. Reconnect it to continue.",
  paused: "Paused.",
  upToDate: "Up to date.",
  waitingPlan: "Waiting for your DeepWell plan to be active.",
  waitingAllowance: "Your monthly allowance is used for now. New files will come in when it resets.",
  senderNotAllowed: "This sender is not on your list, so the message was not imported.",
});
