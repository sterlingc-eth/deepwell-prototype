import { requireAuth, denyAuth } from "../auth.js";
import { handleCors, handleError } from "../claude.js";
import { isQueueEnabled, enqueueAccountExport } from "../queue.js";
import { assertAdmin, startExport, runExportStep, jobStatus, downloadLink, publicJob, isJobId } from "../accountExport.js";

/**
 * POST /api/account?action=export-files     body: { op, jobId?, part? }       (admin only)
 *
 *   op 'start'   -> begin "Download all my files"; { job, mode: 'background' | 'page' }
 *   op 'status'  -> { job }  (the given job, or the latest; job is null when there has never been one)
 *   op 'step'    -> build the next part NOW. Only for a deployment with no queue: the open page calls it again and again.
 *   op 'link'    -> { url, name, expiresInSeconds }  a fresh 1-hour link for one part (part = 1, 2, ... or 'index')
 *
 * The tenant is always the verified token's; a job id from the body is only ever looked up UNDER that tenant's own storage
 * prefix, so another company's id finds nothing. Every op is admin only (a solo tenant is its own admin). See accountExport.js.
 */
export const config = { api: { bodyParser: { sizeLimit: "4kb" } } };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return handleCors(res, req).status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let auth;
  try {
    auth = await requireAuth(req);
    assertAdmin(auth);
  } catch (err) {
    return denyAuth(res, err);
  }
  const ctx = { tenantKey: auth.tenantId, tenantName: auth.orgId ?? auth.tenantId };
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const op = String(body.op ?? "status");
  const send = (status, payload) => handleCors(res, req).setHeader("Cache-Control", "no-store").status(status).json(payload);

  try {
    if (op === "status") {
      if (body.jobId != null && !isJobId(body.jobId)) return send(400, { error: "That download was not found." });
      return send(200, { job: await jobStatus(ctx, body.jobId ?? null) });
    }

    if (op === "start") {
      const { state, reused } = await startExport(ctx, auth);
      let mode = "page";
      if (!reused && isQueueEnabled()) {
        try {
          await enqueueAccountExport({ jobId: state.jobId, tenantKey: ctx.tenantKey, tenantName: ctx.tenantName, userId: auth.userId ?? null });
          mode = "background";
        } catch (err) {
          console.error("account export: could not queue, the page will drive it:", err?.message);
        }
      } else if (reused && isQueueEnabled()) mode = "background";
      return send(200, { job: publicJob(state), mode, reused });
    }

    if (op === "step") {
      if (isQueueEnabled()) return send(409, { error: "Your files are being prepared in the background." });
      if (!isJobId(body.jobId)) return send(400, { error: "That download was not found." });
      const { job } = await runExportStep(ctx, body.jobId);
      return send(200, { job });
    }

    if (op === "link") {
      if (!isJobId(body.jobId)) return send(400, { error: "That download was not found." });
      const part = body.part === "index" ? "index" : Number(body.part);
      return send(200, await downloadLink(ctx, auth, body.jobId, part));
    }

    return send(400, { error: "Unknown request." });
  } catch (error) {
    if (error?.expose && error.status) return send(error.status, { error: error.message });
    return handleError(res, error, req, { tenantId: auth.tenantId });
  }
}
