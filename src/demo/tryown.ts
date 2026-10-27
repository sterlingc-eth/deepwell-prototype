/**
 * "Try your own documents" on the public demo page: the browser side.
 *
 * Everything the visitor uploads is read ONCE by the server (api/_lib/demo/tryown) and nothing is kept: the results live in React state
 * in this tab and disappear when the tab closes or "Try different documents" is pressed. The only thing remembered between visits to the
 * panel is a random session id in sessionStorage, which the server uses to count uploads and questions (it is not an account).
 *
 * The limits below mirror the server's (api/_lib/demo/tryown/config.js) so a visitor is told BEFORE uploading; the server re-checks all
 * of them and is the one that enforces.
 */

export const TRYOWN = {
  maxFiles: 3,
  maxPages: 10,
  maxFileBytes: 15 * 1024 * 1024,
  maxQuestions: 5,
  types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const,
  /** Listing the exact types (not "image/*") makes iPad / iPhone hand over JPEG instead of HEIC. */
  accept: 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp',
} as const;

/** Visitor-facing text. The server has the same sentences for its own errors (api/_lib/demo/tryown/config.js); scripts/verify-demo-tryown.ts checks the two stay identical. */
export const TRYOWN_TEXT = {
  notice: 'Your files are read once to show you how DeepWell works and are not kept.',
  panelTitle: 'Try your own documents',
  panelIntro: 'Upload up to 3 of your own papers (PDF or photo, 10 pages in all). DeepWell reads them and you can ask Donovan about them.',
  dropHint: 'Choose files or drop them here',
  accepted: 'PDF, JPEG, PNG or WebP · up to 3 files · 10 pages in all · 15 MB each',
  readButton: 'Read my documents',
  again: 'Try different documents',
  back: 'Back to the sample workspace',
  working: 'Reading your documents…',
  stages: ['Uploading', 'Reading pages', 'Finding fields', 'Writing a summary'],
  resultsTitle: 'What DeepWell found',
  fieldsTitle: 'Fields found',
  summaryTitle: 'Summary',
  askTitle: 'Ask Donovan about your documents',
  askPlaceholder: 'Ask about your documents',
  askButton: 'Ask',
  questionsLeft: (n: number) => `${n} ${n === 1 ? 'question' : 'questions'} left`,
  noQuestionsLeft: 'You have used all 5 questions. Start over to try again.',
  maskedNote: 'Birth dates and ID, account and card numbers are never shown. Only the last 4 characters of a number appear.',
  unavailable: 'The live document demo is resting right now. The sample workspaces still work.',
  generic: 'Something went wrong reading those files. Please try again.',
  tooManyFiles: 'Please choose up to 3 files.',
  tooBig: 'One of those files is larger than 15 MB.',
  wrongType: 'Please choose a PDF or a photo (JPEG, PNG or WebP).',
  heic: 'That looks like an iPhone HEIC photo. Please choose a JPEG or PNG instead.',
  emptyFile: 'One of those files is empty.',
  entry: 'Have your own papers? Try your own documents',
  remove: 'Remove',
  sources: 'From your documents',
  pagesWord: (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`,
} as const;

export interface PickedFile { name: string; size: number; type: string }

/** The file's type as the browser reports it, falling back to the extension (some browsers leave it empty). */
export function typeOf(f: PickedFile): string {
  const t = (f.type || '').toLowerCase();
  if (t) return t === 'image/jpg' ? 'image/jpeg' : t;
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  return ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[ext] ?? '';
}

/** First problem with a picked set, in the visitor's words, or null. Pure. */
export function checkPicked(files: PickedFile[]): string | null {
  if (files.length === 0) return null;
  if (files.length > TRYOWN.maxFiles) return TRYOWN_TEXT.tooManyFiles;
  for (const f of files) {
    const t = typeOf(f);
    if (f.size <= 0) return TRYOWN_TEXT.emptyFile;
    if (t === 'image/heic' || t === 'image/heif') return TRYOWN_TEXT.heic;
    if (!(TRYOWN.types as readonly string[]).includes(t)) return TRYOWN_TEXT.wrongType;
    if (f.size > TRYOWN.maxFileBytes) return TRYOWN_TEXT.tooBig;
  }
  return null;
}

/* ------------------------------------------------------------------ session id (a counter key, not an account) */
const SID_KEY = 'dw-demo-try-sid';
let memorySid: string | null = null;
export function sessionId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof sessionStorage === 'undefined' ? null : sessionStorage): string {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!storage) return (memorySid ??= fresh());
  try {
    const got = storage.getItem(SID_KEY);
    if (got && /^[a-f0-9]{32}$/.test(got)) return got;
    const sid = fresh();
    storage.setItem(SID_KEY, sid);
    return sid;
  } catch {
    return (memorySid ??= fresh()); // storage blocked (private mode): one id for this page view
  }
}

/* ------------------------------------------------------------------ API */
export interface TryField { label: string; value: string; masked: boolean }
export interface TryDoc {
  i: number; ok: boolean; error?: string; pages?: number; type?: string; typeLabel?: string; how?: string; readHow?: string;
  fields?: TryField[]; summary?: string;
}
export interface TryReadResult { ok: boolean; docs: TryDoc[]; ctx: string | null; questionsLeft: number; notice?: string; error?: string }
export interface TryAnswer { ok: boolean; found?: boolean; answer?: string; sources?: Array<{ doc: number; quote: string }>; questionsLeft?: number; error?: string }
export interface TryStatus { enabled: boolean; message?: string }

const ENDPOINT = '/api/account?action=demo-try';
async function post(op: string, body: Record<string, unknown>, fetcher: typeof fetch): Promise<Record<string, any>> {
  const r = await fetcher(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }) });
  let j: Record<string, any> = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok && !j.error) j.error = TRYOWN_TEXT.generic;
  return { ...j, ok: r.ok && j.ok !== false };
}

export async function fetchStatus(fetcher: typeof fetch = fetch): Promise<TryStatus> {
  try {
    const r = await fetcher(`${ENDPOINT}&op=status`);
    const j = await r.json();
    return { enabled: !!j.enabled, message: j.message };
  } catch {
    return { enabled: false, message: TRYOWN_TEXT.unavailable };
  }
}

/** Upload (straight to temporary storage) then read. `onStage` gets 0..3 for the progress chips. Throws Error(message) with a sentence fit to show. */
export async function readFiles(files: File[], pack: string | undefined, onStage: (i: number) => void, fetcher: typeof fetch = fetch): Promise<TryReadResult> {
  const problem = checkPicked(files);
  if (problem) throw new Error(problem);
  const sid = sessionId();
  onStage(0);
  const p = await post('presign', { sid, files: files.map((f) => ({ name: f.name.slice(0, 120), size: f.size, type: typeOf(f) })) }, fetcher);
  if (!p.ok) throw new Error(String(p.error || TRYOWN_TEXT.generic));
  const uploads = p.uploads as Array<{ url: string }>;
  await Promise.all(files.map(async (f, i) => {
    const r = await fetcher(uploads[i]!.url, { method: 'PUT', body: f });
    if (!r.ok) throw new Error(TRYOWN_TEXT.generic);
  }));
  onStage(1);
  // the server does the reading in one request; the later chips advance on a timer so the visitor sees the steps
  const t2 = setTimeout(() => onStage(2), 2500);
  const t3 = setTimeout(() => onStage(3), 5000);
  try {
    const j = await post('read', { sid, ticket: p.ticket, names: files.map((f) => f.name.slice(0, 120)), ...(pack ? { pack } : {}) }, fetcher);
    if (!j.docs && !j.ok) throw new Error(String(j.error || TRYOWN_TEXT.generic));
    return { ok: !!j.ok, docs: j.docs ?? [], ctx: j.ctx ?? null, questionsLeft: Number(j.questionsLeft ?? TRYOWN.maxQuestions), notice: j.notice, error: j.error };
  } finally { clearTimeout(t2); clearTimeout(t3); }
}

export async function askQuestion(question: string, ctx: string, fetcher: typeof fetch = fetch): Promise<TryAnswer> {
  const j = await post('ask', { sid: sessionId(), question, ctx }, fetcher);
  return { ok: !!j.ok, found: j.found, answer: j.answer, sources: j.sources, questionsLeft: j.questionsLeft, error: j.error };
}
