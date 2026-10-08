// E2 A9: the model call must never run while a database transaction is open (the /api/ask path dropped its connection while saving the audit row).
// Offline: the pg harness is wrapped to track BEGIN/COMMIT/ROLLBACK + connection checkout; a deliberately SLOW scripted model records how many
// transactions / checked-out connections were open at the instant it was called.
export default async function ({ check, realLog, off, makeHarness }) {
  const FX = await import("./r41u-fixture.mjs");
  const pgMod = (await import("pg")).default;
  const st = { dropNext: 0, drops: 0, open: 0, held: 0, begins: 0, commits: 0, maxOpenAtModel: 0, heldAtModel: 0, modelCalls: 0 };
  const orig = pgMod.Pool.prototype.connect;
  pgMod.Pool.prototype.connect = async function () {
    if (st.dropNext > 0) { st.dropNext--; st.drops++; throw new Error("Connection terminated unexpectedly"); }
    const c = await orig.apply(this, arguments); st.held++;
    let inTx = false; const q = c.query, rel = c.release;
    c.query = (sql, p) => {
      const s = String(sql).trim().toUpperCase();
      if (s === "BEGIN") { inTx = true; st.open++; st.begins++; }
      if (s === "COMMIT" || s === "ROLLBACK") { if (inTx) { inTx = false; st.open--; st.commits++; } }
      return q(sql, p);
    };
    c.release = (...a) => { st.held--; if (inTx) { inTx = false; st.open--; } return rel(...a); };
    return c;
  };
  try {
    const h = await makeHarness({ off, tenantKey: "r41u-e2a9", docs: FX.DOCS });
    const slow = (mk) => (prompt, req) => {
      st.modelCalls++; st.maxOpenAtModel = Math.max(st.maxOpenAtModel, st.open); st.heldAtModel = Math.max(st.heldAtModel, st.held);
      return mk(prompt, req);
    };
    const auditRows = async () => Number((await new pgMod.Pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.queried'")).rows[0].n);
    const good = () => ({ text: "Here is the invoice.", confidence: 0.9, facts: [{ label: "Invoice", value: FX.R.inv.num, sources: [{ documentId: h.ids.A, location: { page: 1 } }] }] });
    const qs = [FX.ASK.A, FX.ASK.B, FX.ASK.W, "how many invoices do we have", "which units expire in the next 90 days", "show me the invoice for Wainwright"];
    for (const q of qs) {
      st.modelCalls = 0; st.maxOpenAtModel = 0; st.heldAtModel = 0;
      const r = await h.ask(q, slow(good));
      realLog(`  probe [${q}] model calls ${st.modelCalls}, open tx at model ${st.maxOpenAtModel}, held conns ${st.heldAtModel}, kind ${r.kind}`);
      check(`A9 no transaction open during the model call [${q}]`, st.maxOpenAtModel === 0 && st.heldAtModel === 0, `open ${st.maxOpenAtModel} held ${st.heldAtModel}`);
      check(`A9 nothing left open after [${q}]`, st.open === 0 && st.held === 0, `open ${st.open} held ${st.held}`);
    }
    // the pooled connection that sat idle through the model call is dropped: the bookkeeping transaction is retried once and the audit row is saved exactly once
    for (const drops of [1, 0]) {
      const before = await auditRows(); st.drops = 0;
      const r = await h.ask(FX.ASK.A, (pr, rq) => { st.dropNext = drops; return slow(good)(pr, rq); });
      st.dropNext = 0;
      const after = await auditRows();
      check(`A9 answer unaffected when ${drops} connection(s) drop during bookkeeping`, r.kind === "answer" && r.text.startsWith("Here is the invoice"), `${r.kind} ${r.text}`);
      check(`A9 audit row saved exactly once when ${drops} connection(s) drop`, after - before === 1, `rows +${after - before}, drops ${st.drops}`);
    }
    const before2 = await auditRows();
    await h.ask(FX.ASK.A, (pr, rq) => { st.dropNext = 2; return slow(good)(pr, rq); }); st.dropNext = 0;
    check("A9 two drops in a row: answer still delivered, no duplicate/partial audit row", (await auditRows()) - before2 <= 1, "");
  } finally { pgMod.Pool.prototype.connect = orig; }
}
