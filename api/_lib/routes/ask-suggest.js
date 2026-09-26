/**
 * ask-suggest — HTTP surface (POST /api/account?action=ask-suggest, dispatched by `op`), Round 14 K1.
 *
 * Owner ask (R14_CONTRACT.md): "Are we able to have Donovan provide sample prompts or predict input so
 * users have a better chance at Donovan not returning a failed query?" This is that route. No model call
 * anywhere in this file — every op below is either pure shape detection (suggest/classify.js,
 * suggest/templates.js) or a cached, tenant-scoped SQL read (vocab/tenantVocab.js, this feature's own
 * suggest/vocabExtras.js); it must keep working exactly the same with Anthropic credits OUT, same as the
 * rest of the deterministic pre-router chain it mirrors.
 *
 *   { op: 'typeahead', text }   -> { completions:[{id,text,category}], hint:{level,message,route}|null }
 *   { op: 'samples', role }    -> { prompts:[{id,text,category}] }              role: 'tech' | 'office'
 *   { op: 'didyoumean', text } -> { chips:[{text}] }
 *
 * Any authenticated tenant member can call every op here — read-only, no admin gate, same bar as
 * naming.js's own `rename` (a field tech typing into the Ask box is not an admin action). Rate-limited
 * under the generous 'read' bucket, never 'ask': this never reaches the model and must never count
 * against, or be throttled by, the monthly ask allowance a real question spends.
 */
import { requireAuth, denyAuth, AuthError } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { limit as rateLimit } from "../rateLimit.js";
import { withTenant } from "../recordsStore.js";
import { packForTenant } from "../industry/index.js";
import { getTenantVocab, correctTenantNameTypos } from "../vocab/tenantVocab.js";
import { getActiveOverlayForTenant } from "../learning/overlay.js";
import { getStreetVocab, correctStreetTypos } from "../streetVocab.js";
import { getSuggestVocabExtras } from "../suggest/vocabExtras.js";
import { classifyPreflight } from "../suggest/classify.js";
import { buildValidatedPrompts, rankTypeahead, buildDidYouMean } from "../suggest/templates.js";

export const config = { api: { bodyParser: { sizeLimit: "8kb" } }, maxDuration: 30 };

const MAX_TEXT = 300;
const ROLES = new Set(["tech", "office"]);
const OPS = new Set(["typeahead", "samples", "didyoumean"]);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
  } catch (err) {
    return denyAuth(res, err);
  }
  if (!(await rateLimit(req, res, auth, "read"))) return;

  const body = req.body ?? {};
  const op = typeof body.op === "string" ? body.op : "";
  if (!OPS.has(op)) return res.status(400).json({ error: "op must be one of: typeahead, samples, didyoumean" });

  const ok = (data) => handleCors(res, req).status(200).json(data);
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };

  try {
    // Same three lookups ask.js itself resolves before its own pre-router chain runs — never throws
    // (each degrades to the generic/no-vocab case on its own, same "warn once, keep going" convention as
    // ask.js's own overlay/pack/vocab blocks), and cached per-tenant so a call during this same warm
    // instance is a Map lookup, not a fresh set of queries.
    const overlay = await getActiveOverlayForTenant(ctx);
    const pack = await packForTenant({ withTenant, ctxArg: ctx });
    let tenantVocab = null;
    let extras = { addresses: [], serials: [], zips: [] };
    let streetVocab = null;
    try {
      [tenantVocab, extras, streetVocab] = await withTenant(ctx, (db) =>
        Promise.all([
          getTenantVocab(db, auth.tenantId, pack),
          getSuggestVocabExtras(db, auth.tenantId),
          getStreetVocab(db, auth.tenantId).catch(() => null),
        ])
      );
    } catch (err) {
      console.error("ask-suggest: tenant vocab lookup failed, degrading to generic templates:", err?.message);
    }
    const classifyCtx = { overlay, pack, tenantVocab };
    const fillVocab = { ...(tenantVocab ?? {}), ...extras };

    if (op === "typeahead") {
      const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
      const candidates = buildValidatedPrompts(fillVocab, { role: null, limitPerTemplate: 4, ctx: classifyCtx });
      const completions = rankTypeahead(text, candidates, 6);
      const hint = text.trim().length >= 3 ? classifyPreflight(text, classifyCtx) : null;
      return ok({ completions, hint });
    }

    if (op === "samples") {
      const role = ROLES.has(body.role) ? body.role : "office";
      const prompts = buildValidatedPrompts(fillVocab, { role, limitPerTemplate: 1, ctx: classifyCtx }).slice(0, 6);
      return ok({ prompts });
    }

    // op === "didyoumean"
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
    if (!text.trim()) return ok({ chips: [] });
    const chips = buildDidYouMean(text, fillVocab, classifyCtx, { correctTenantNameTypos, correctStreetTypos, streetVocab });
    return ok({ chips });
  } catch (error) {
    if (error instanceof AuthError) return handleCors(res, req).status(error.status).json({ error: error.message });
    return handleError(res, error, req);
  }
}
