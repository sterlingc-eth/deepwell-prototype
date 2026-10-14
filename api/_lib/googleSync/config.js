/**
 * Google sync: switches, scopes, limits and the customer-visible wording, in one place.
 *
 * EVERYTHING HERE SHIPS OFF. DEEPWELL_GOOGLE_SYNC must be exactly "1" for any of it to run; with it unset the route answers
 * {enabled:false}, the scheduled step returns at once without opening a database connection, and the Settings card stays hidden.
 */

/** The master switch. Read from the environment each call so tests can flip it. */
export function isGoogleSyncEnabled(env = process.env) {
  return String(env.DEEPWELL_GOOGLE_SYNC ?? "") === "1";
}

export const PROVIDERS = Object.freeze(["drive", "gmail"]);

/**
 * OAuth scopes.
 *  - drive.file     : NON-sensitive. DeepWell sees only the files/folders the admin picks in Google's own picker.
 *  - drive.readonly : RESTRICTED. DeepWell can read every file in the Drive (never change it); the admin then chooses folders.
 *  - gmail.readonly : RESTRICTED. The narrowest Gmail scope that can download attachments (gmail.metadata cannot).
 * "openid email" (non-sensitive) is added so the screen can show which Google account is connected.
 */
export const SCOPES = Object.freeze({
  "drive:narrow": ["https://www.googleapis.com/auth/drive.file"],
  "drive:full": ["https://www.googleapis.com/auth/drive.readonly"],
  "gmail:full": ["https://www.googleapis.com/auth/gmail.readonly"],
});
export const IDENTITY_SCOPES = Object.freeze(["openid", "email"]);

export function scopesFor(provider, mode) {
  const key = provider === "gmail" ? "gmail:full" : `drive:${mode === "full" ? "full" : "narrow"}`;
  return [...IDENTITY_SCOPES, ...SCOPES[key]];
}

/** Limits. Every number can be lowered (never raised past the hard ceiling) with an env variable. */
function intFromEnv(raw, fallback, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
export function limits(env = process.env) {
  return {
    /** Files one organization can have imported from Google per UTC day (all sources together). */
    maxFilesPerDay: intFromEnv(env.GOOGLE_SYNC_MAX_FILES_PER_DAY, 200, 1, 2000),
    /** Files one sync pass of one connection handles; the rest carry to the next pass. */
    maxFilesPerRun: intFromEnv(env.GOOGLE_SYNC_MAX_FILES_PER_RUN, 40, 1, 200),
    /** Total files one connection may bring in over its life. */
    maxFilesPerConnection: intFromEnv(env.GOOGLE_SYNC_MAX_FILES_TOTAL, 5000, 1, 50000),
    /** A Google Doc/Sheet export is refused by Google above ~10 MB; PDFs and photos are capped at 24 MB by the upload rules. */
    maxBytesPerFile: 24 * 1024 * 1024,
    /** Wall-clock budget of one connection's pass. */
    runBudgetMs: intFromEnv(env.GOOGLE_SYNC_RUN_BUDGET_MS, 40_000, 1000, 240_000),
    /** Gmail look-back choices (days) offered at connect time. */
    gmailLookbackDays: [7, 30, 90],
    /** Gmail: attachments smaller than this that are inline images (signature logos) are skipped. */
    gmailMinImageBytes: 15 * 1024,
    /** Folders / files / labels / senders an admin can choose. */
    maxPicked: 50,
    maxSenders: 25,
    maxLabels: 20,
    /** Drive folders walked for ancestry / listing in one pass. */
    maxFolderDepth: 12,
  };
}

/** Google file types that are exported rather than downloaded. [exportMime, extension] */
export const EXPORTS = Object.freeze({
  "application/vnd.google-apps.document": ["application/pdf", "pdf"],
  // Whole workbook as .xlsx (all tabs). A CSV export would carry only the first tab.
  "application/vnd.google-apps.spreadsheet": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  "application/vnd.google-apps.presentation": ["application/pdf", "pdf"],
});
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Customer-visible wording. Plain, positive, factual. Listed in the build report for owner approval.
 * Never mentions tokens, scopes or internal names.
 */
export const WORDING = Object.freeze({
  title: "Connected sources",
  intro: "Keep saving files in Google Drive and receiving invoices in Gmail. DeepWell picks them up automatically, reads them like any file you upload, and Donovan can answer from them.",
  driveTitle: "Google Drive",
  driveBlurb: "DeepWell brings in the files from the folders you choose, and checks for new and changed files all day.",
  gmailTitle: "Gmail",
  gmailBlurb: "DeepWell brings in the attachments from the labels and senders you choose, such as invoices and statements. It does not import the emails themselves.",
  connectDrive: "Connect Google Drive",
  connectGmail: "Connect Gmail",
  modeNarrow: "Only the folders and files I choose",
  modeNarrowHelp: "You pick folders and files in Google's own picker, and DeepWell can see only those.",
  modeFull: "Read access to my whole Drive",
  modeFullHelp: "DeepWell can read your Drive but never change it. You then choose which folders to bring in.",
  chooseFiles: "Choose folders and files",
  chooseFolders: "Choose folders",
  chooseLabels: "Labels to bring attachments from",
  chooseSenders: "Senders to bring attachments from",
  sendersHelp: "Separate addresses with commas. Leave empty to use labels only.",
  lookback: "Start with email from the last",
  save: "Save choices",
  syncNow: "Sync now",
  pause: "Pause",
  resume: "Resume",
  disconnect: "Disconnect",
  disconnectNote: "Files already in DeepWell stay. DeepWell stops checking Google and removes its access.",
  lastSync: "Last checked",
  never: "Not checked yet",
  imported: "Files brought in",
  removedInGoogle: "No longer in Google",
  removedHelp: "These were removed from Google after DeepWell brought them in. DeepWell keeps its copy.",
  needsReconnect: "Google asked you to sign in again. Choose Connect to continue.",
  paused: "Paused. Nothing is being checked.",
  working: "Working",
  adminOnly: "Only a company admin can connect Google accounts.",
  dailyLimit: "Today's limit for bringing in files from Google has been reached. DeepWell continues tomorrow.",
});
