/**
 * Donovan Scorecard - BREADTH questions (the owner's bar: "ask Donovan ANY question about the business").
 *
 * The bank-derived exam (scripts/gen-scorecard.mjs) covers what the bank covers: counts, lookups, warranty, geography.
 * This module adds the categories it lacked, each question hand-written the way an owner, office manager, tech or
 * bookkeeper would ask it, each with an INDEPENDENT oracle (SQL over the base tables; the financials questions read
 * document_financials / document_financial_lines from M3-config/22):
 *
 *   financials-*   invoices, totals by period, open / overdue, AR aging, revenue, quotes, agreement fees, POs
 *   content        what the document TEXT says (capacitor replaced, refrigerant added, leak found ...)
 *   semantic       paraphrases of a symptom ("the unit is loud" = a noise complaint)
 *   multi-hop      stacked conditions across customers, units, agreements and warranties
 *   trends         "are service calls up vs last quarter"
 *   rankings       superlatives ("which customer has the most units")
 *   tech-performance  per-technician work
 *   data-quality   "documents missing a customer", duplicates, missing serials
 *   existence      yes / no "do we have any ..."
 *   explain        "why" / "what was done" questions (rubric-graded, must cite)
 *   persona        self-contained owner / office / tech / bookkeeper phrasings
 *
 * Every question is tagged with persona + category; `citationRequired` defaults to yes (an answer that is right but
 * carries no source fails); rubric questions say what must be cited (`citeWhat`). A question whose data is absent is
 * RETIRED at run time (oracle.requires guard / missing table), never failed. Rubric questions are capped by the generator.
 *
 * Pure: takes the SQL kit from gen-scorecard.mjs, returns plain objects. No DB, no model.
 */

const NAMES = ["Mercer", "Salazar", "Delgado", "Rios", "Holbrook", "Thornton", "Prentiss", "Abernathy", "Norwood", "Wyckoff", "Keller", "Ortega"];
const TECHS = ["Danny Ochoa", "Marisol Vega", "Kevin Pratt", "Denise Ford", "Ray Sutton", "Wyatt Coburn"];
const BRANDS = ["Trane", "Carrier", "Lennox", "Goodman", "Rheem", "York"];
const CITIES = ["Mesa", "Tucson", "Chandler", "Gilbert", "Casa Grande", "Tempe"];

export function breadthQuestions(k) {
  const { Q, ISO, DOCTYPE, DOCTYPE_ALIASES, GEO, EQUIP, wstatus, installYear, esc, subjectSql, VISIT_TYPES, MONTHS } = k;
  const out = [];
  const counters = {};

  /** Renumber the $n placeholders a SQL text actually uses to $1..$m (in order of first use) and pick the matching params. */
  const compact = (sql, params) => {
    const order = [];
    const text = sql.replace(/\$(\d+)/g, (_m, d) => { const i = Number(d); if (!order.includes(i)) order.push(i); return `$${order.indexOf(i) + 1}`; });
    return { sql: text.replace(/\s+/g, " ").trim(), params: order.map((i) => params[i - 1]) };
  };

  /** add one question. `build(q)` returns {cmp, sql, requires?, alt?, scope?, rubric?, flags?} using q.p / q.today
   *  for binds; every SQL text is compacted to the params it uses. `scope` (TEAM T3, 2026-09-25) is an
   *  OPTIONAL {sql, params} returning `document_id` - the exact documents this question's own answer is
   *  drawn from, read by the Claude baseline (api/_lib/scorecard/baseline.js's candidateDocIds) as the
   *  "oracle's own candidate set" instead of its generic keyword fallback. */
  function add(category, persona, text, build, flags = {}) {
    const q = new Q();
    const spec = build(q);
    const n = (counters[category] = (counters[category] ?? 0) + 1);
    const id = `breadth-${category}-${String(n).padStart(3, "0")}`;
    const main = compact(spec.sql, spec.params ?? q.params);
    const withParams = (x) => compact(x.sql, x.params ?? q.params);
    const question = {
      id, base: id, variant: "canonical", category, persona, text, cmp: spec.cmp,
      oracle: {
        ...main,
        ...(spec.requires ? { requires: withParams(spec.requires) } : {}),
        ...(spec.alt ? { alt: withParams(spec.alt) } : {}),
        ...(spec.scope ? { scope: withParams(spec.scope) } : {}),
      },
      ...(spec.rubric ? { rubric: spec.rubric } : {}),
      ...flags, ...(spec.flags ?? {}),
    };
    out.push(question);
  }

  /* ---------------------------------------------------------------- shared SQL */
  const CUST = "entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL";
  const numc = (col) => `COALESCE(CASE WHEN f.corrections->>'${col}' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (f.corrections->>'${col}')::numeric END, f.${col})`;
  const datec = (col) => `COALESCE(CASE WHEN f.corrections->>'${col}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (f.corrections->>'${col}')::date END, f.${col})`;
  const TOTAL = numc("total");
  const PAID = numc("amount_paid");
  const BAL = `COALESCE(${numc("balance_due")}, CASE WHEN f.status = 'paid' THEN 0 WHEN f.status IN ('unpaid','partial') THEN ${TOTAL} - COALESCE(${PAID}, 0) END)`;
  const INV = "f.doc_kind = 'invoice' AND f.direction = 'receivable'";
  const OPEN = "f.status IN ('unpaid','partial')";
  const IDATE = datec("invoice_date");
  const DUE = datec("due_date");
  // TEAM F (scorecard correctness, 2026-09-24): most invoices print no payment status at all (status is
  // NULL), so a "how many are unpaid/overdue/paid" count of the KNOWN rows can look like a confident
  // "0" or "1 of 68" when really "we can't tell for the other 67". UNKNOWN_STATUS is that unclassified
  // set (used inside a FILTER alongside an outer `WHERE ${INV}`, so it does not repeat INV itself);
  // OVERDUE_UNKNOWN adds "no due_date printed" since an overdue verdict also needs that field.
  // See compare.js's compareCountWithUnknown / cmp "count-with-unknown".
  const UNKNOWN_STATUS = `f.status IS NULL OR f.status NOT IN ('paid','unpaid','partial')`;
  const OVERDUE_UNKNOWN = `(${UNKNOWN_STATUS}) OR (${OPEN} AND ${DUE} IS NULL)`;
  const FIN_REQ = (kind, dir = "receivable") => ({ sql: `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = '${kind}' AND f.direction = '${dir}'` });
  const money = { tolerance: 1, anyNumber: true };
  const agr = (q) => `${q.p(DOCTYPE_ALIASES["maintenance-agreement"])}::text[]`;
  const custDoc = (types) => `EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id LEFT JOIN entities le ON le.id = l.entity_id WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND ${DOCTYPE("d.document_type")} = ANY(${types}::text[]))`;
  const custUnit = (extra = "") => `EXISTS (SELECT 1 FROM ${EQUIP} AND e.customer_id = c.id${extra})`;
  const vt = (q) => `${q.p(VISIT_TYPES)}::text[]`;
  const windowFor = (name, q) => {
    const T = q.today();
    switch (name) {
      case "this month": return { start: `date_trunc('month', ${T})::date`, end: `(date_trunc('month', ${T}) + interval '1 month')::date` };
      case "last month": return { start: `(date_trunc('month', ${T}) - interval '1 month')::date`, end: `date_trunc('month', ${T})::date` };
      case "the month before last": return { start: `(date_trunc('month', ${T}) - interval '2 months')::date`, end: `(date_trunc('month', ${T}) - interval '1 month')::date` };
      case "this year": return { start: `date_trunc('year', ${T})::date`, end: `(date_trunc('year', ${T}) + interval '1 year')::date` };
      case "last year": return { start: `(date_trunc('year', ${T}) - interval '1 year')::date`, end: `date_trunc('year', ${T})::date` };
      case "last quarter": return { start: `(date_trunc('quarter', ${T}) - interval '3 months')::date`, end: `date_trunc('quarter', ${T})::date` };
      case "the quarter before last": return { start: `(date_trunc('quarter', ${T}) - interval '6 months')::date`, end: `(date_trunc('quarter', ${T}) - interval '3 months')::date` };
      default: {
        const mi = MONTHS.indexOf(name);
        if (mi < 0) throw new Error(`breadth: unknown window ${name}`);
        const start = `make_date(CASE WHEN ${mi + 1} > EXTRACT(MONTH FROM ${T})::int THEN EXTRACT(YEAR FROM ${T})::int - 1 ELSE EXTRACT(YEAR FROM ${T})::int END, ${mi + 1}, 1)`;
        return { start, end: `(${start} + interval '1 month')::date` };
      }
    }
  };
  const subj = (name, q) => subjectSql({ kind: "name", value: name }, q);

  /* ================================================================ FINANCIALS (retire when the tables / rows are absent) */
  const fin = (persona, text, sql, extra = {}, flags = money, reqKind = "invoice", reqDir = "receivable") =>
    add(extra.category ?? "financials", persona, text, (q) => ({ cmp: extra.cmp ?? "number", sql: typeof sql === "function" ? sql(q) : sql, requires: FIN_REQ(reqKind, reqDir), ...(extra.rubric ? { rubric: extra.rubric } : {}) }), flags);
  const count = { tolerance: 0 };

  // TEAM F: `known` extra.cmp for the status-count questions below - "how many are unpaid/paid/overdue/
  // partial" all depend on a status/due_date field most invoices never print. `count` is still used for
  // "how many invoices on file" (no status involved, nothing unknown to disclose).
  const knownUnknown = { cmp: "count-with-unknown" };

  // -- how many invoices, by state
  fin("bookkeeper", "How many invoices do we have on file?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV}`, {}, count);
  fin("bookkeeper", "How many invoices are still unpaid?", `SELECT count(*) FILTER (WHERE ${OPEN}) AS n, count(*) FILTER (WHERE ${UNKNOWN_STATUS}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("office", "how many open invoices are there", `SELECT count(*) FILTER (WHERE ${OPEN}) AS n, count(*) FILTER (WHERE ${UNKNOWN_STATUS}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("bookkeeper", "How many invoices have been paid?", `SELECT count(*) FILTER (WHERE f.status = 'paid') AS n, count(*) FILTER (WHERE ${UNKNOWN_STATUS}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("bookkeeper", "How many invoices are overdue?", (q) => `SELECT count(*) FILTER (WHERE ${OPEN} AND ${DUE} < ${q.today()}) AS n, count(*) FILTER (WHERE ${OVERDUE_UNKNOWN}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("owner", "How many of our invoices are past due right now?", (q) => `SELECT count(*) FILTER (WHERE ${OPEN} AND ${DUE} < ${q.today()}) AS n, count(*) FILTER (WHERE ${OVERDUE_UNKNOWN}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("bookkeeper", "How many invoices are more than 60 days overdue?", (q) => `SELECT count(*) FILTER (WHERE ${OPEN} AND ${DUE} < ${q.today()} - 60) AS n, count(*) FILTER (WHERE ${OVERDUE_UNKNOWN}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  fin("bookkeeper", "How many invoices are partially paid?", `SELECT count(*) FILTER (WHERE f.status = 'partial') AS n, count(*) FILTER (WHERE ${UNKNOWN_STATUS}) AS u FROM document_financials f WHERE ${INV}`, knownUnknown, count);
  // -- money owed (AR)
  fin("owner", "How much are we owed in total?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN}`);
  fin("owner", "What's the total dollar amount of our open invoices?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN}`);
  fin("bookkeeper", "What are our outstanding receivables?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN}`);
  fin("bookkeeper", "What is our total accounts receivable balance?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN}`);
  fin("owner", "Are we owed any money? How much?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN}`);
  fin("bookkeeper", "How much is past due?", (q) => `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()}`);
  fin("bookkeeper", "What's our AR aging: how much is more than 30 days past due?", (q) => `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()} - 30`);
  fin("bookkeeper", "How much is more than 60 days past due?", (q) => `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()} - 60`);
  fin("bookkeeper", "How much do we have outstanding over 90 days?", (q) => `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()} - 90`);
  fin("bookkeeper", "How much of our receivables is current, not yet due?", (q) => `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND (${DUE} IS NULL OR ${DUE} >= ${q.today()})`);
  // -- revenue / invoiced totals by period
  fin("owner", "How much have we invoiced in total?", `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV}`);
  fin("owner", "What's our total revenue on file?", `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV}`);
  for (const w of ["this month", "last month", "this year", "last year", "last quarter"]) {
    fin("owner", `How much did we invoice ${w}?`, (q) => { const x = windowFor(w, q); return `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; });
  }
  fin("owner", "What was our revenue last month?", (q) => { const x = windowFor("last month", q); return `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; });
  fin("owner", "How much have we billed year to date?", (q) => { const x = windowFor("this year", q); return `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; });
  for (const m of ["august", "june", "march"]) {
    fin("owner", `How much did we invoice in ${m[0].toUpperCase()}${m.slice(1)}?`, (q) => { const x = windowFor(m, q); return `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; });
  }
  fin("owner", "How many invoices did we send last month?", (q) => { const x = windowFor("last month", q); return `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; }, {}, count);
  fin("bookkeeper", "How many invoices went out this year?", (q) => { const x = windowFor("this year", q); return `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end}`; }, {}, count);
  // -- collected
  fin("owner", "How much have we collected in total?", `SELECT coalesce(sum(CASE WHEN f.status = 'paid' THEN ${TOTAL} ELSE ${PAID} END), 0) AS n FROM document_financials f WHERE ${INV}`);
  fin("bookkeeper", "How much money have customers paid us so far?", `SELECT coalesce(sum(CASE WHEN f.status = 'paid' THEN ${TOTAL} ELSE ${PAID} END), 0) AS n FROM document_financials f WHERE ${INV}`);
  fin("bookkeeper", "How much sales tax have we charged on invoices?", `SELECT coalesce(sum(${numc("tax")}), 0) AS n FROM document_financials f WHERE ${INV}`);
  // -- size of invoices
  fin("owner", "What's our average invoice amount?", `SELECT coalesce(avg(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} IS NOT NULL`);
  fin("owner", "What's our average ticket size?", `SELECT coalesce(avg(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} IS NOT NULL`);
  fin("owner", "What's the biggest invoice we've ever sent?", `SELECT coalesce(max(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV}`);
  fin("bookkeeper", "What's our smallest invoice?", `SELECT coalesce(min(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} > 0`);
  fin("owner", "How many invoices are over $5,000?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} > 5000`, {}, count);
  fin("bookkeeper", "How many invoices are under $500?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} < 500`, {}, count);
  // -- who
  fin("owner", "Who's our biggest customer by revenue?", `SELECT g.k AS v FROM (SELECT c.data->>'customer_name' AS k, sum(${TOTAL}) AS t FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} GROUP BY c.id, c.data) g WHERE g.t = (SELECT max(t) FROM (SELECT sum(${TOTAL}) AS t FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} GROUP BY c.id) h)`, { cmp: "value" }, {});
  fin("owner", "Which customer owes us the most right now?", `SELECT g.k AS v FROM (SELECT c.data->>'customer_name' AS k, sum(${BAL}) AS t FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} AND ${OPEN} GROUP BY c.id, c.data) g WHERE g.t = (SELECT max(t) FROM (SELECT sum(${BAL}) AS t FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} AND ${OPEN} GROUP BY c.id) h)`, { cmp: "value" }, {});
  fin("bookkeeper", "Which customers have unpaid invoices?", `SELECT DISTINCT c.data->>'customer_name' AS item FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} AND ${OPEN} ORDER BY 1`, { cmp: "set" }, { maxItems: 25 });
  fin("office", "Who has an overdue balance? I need to call them", (q) => `SELECT DISTINCT c.data->>'customer_name' AS item FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()} ORDER BY 1`, { cmp: "set" }, { maxItems: 25 });
  fin("owner", "Who are our top 3 customers by invoiced revenue?", `SELECT item FROM (SELECT c.data->>'customer_name' AS item, sum(${TOTAL}) AS t FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} GROUP BY c.id, c.data ORDER BY t DESC, 1 LIMIT 3) z`, { cmp: "set" }, {});
  fin("bookkeeper", "How many customers have we invoiced?", `SELECT count(DISTINCT c.id) AS n FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV}`, {}, count);
  // -- quotes vs invoices, agreements, POs
  fin("owner", "How many quotes or estimates do we have on file?", `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = 'estimate'`, {}, count, "estimate");
  fin("owner", "What's the total value of our quotes?", `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'estimate'`, {}, money, "estimate");
  fin("owner", "What's our average quote amount?", `SELECT coalesce(avg(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'estimate' AND ${TOTAL} IS NOT NULL`, {}, money, "estimate");
  fin("owner", "How much have we quoted compared with how much we've invoiced?", `SELECT ((SELECT coalesce(sum(${TOTAL}), 0) FROM document_financials f WHERE f.doc_kind = 'estimate') || ' quoted, ' || (SELECT coalesce(sum(${TOTAL}), 0) FROM document_financials f WHERE ${INV}) || ' invoiced') AS ref`,
    { cmp: "rubric", rubric: "Gives BOTH totals - what has been quoted and what has been invoiced - and they match the reference figures (rounding to the dollar is fine).", category: "financials" }, { citeWhat: "the quote and invoice documents behind the two totals" }, "estimate");
  fin("owner", "How much do our maintenance agreements bring in?", `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'agreement'`, {}, money, "agreement");
  fin("owner", "How many maintenance agreements do we have with a fee on file?", `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = 'agreement' AND ${TOTAL} IS NOT NULL`, {}, count, "agreement");
  fin("owner", "What's the average annual fee on our maintenance agreements?", `SELECT coalesce(avg(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'agreement' AND ${TOTAL} IS NOT NULL`, {}, money, "agreement");
  fin("bookkeeper", "How much have we spent on purchase orders?", `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'po'`, {}, money, "po", "payable");
  fin("bookkeeper", "How many purchase orders do we have?", `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind = 'po'`, {}, count, "po", "payable");
  fin("bookkeeper", "What's our biggest purchase order?", `SELECT coalesce(max(${TOTAL}), 0) AS n FROM document_financials f WHERE f.doc_kind = 'po'`, {}, money, "po", "payable");
  fin("bookkeeper", "How much do we owe vendors right now?", `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE f.direction = 'payable' AND ${OPEN}`, {}, money, "po", "payable");
  // -- money data quality (same tables)
  fin("bookkeeper", "How many invoices are missing a total?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${TOTAL} IS NULL`, { category: "data-quality" }, count);
  fin("bookkeeper", "How many invoices have no due date?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${DUE} IS NULL`, { category: "data-quality" }, count);
  fin("bookkeeper", "How many invoices still need someone to verify the numbers?", `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND f.verified_by IS NULL`, { category: "data-quality" }, count);
  // -- yes / no
  fin("owner", "Do we have any overdue invoices?", (q) => `SELECT EXISTS (SELECT 1 FROM document_financials f WHERE ${INV} AND ${OPEN} AND ${DUE} < ${q.today()}) AS v`, { cmp: "yesno", category: "existence" }, {});
  fin("bookkeeper", "Are there any unpaid invoices?", `SELECT EXISTS (SELECT 1 FROM document_financials f WHERE ${INV} AND ${OPEN}) AS v`, { cmp: "yesno", category: "existence" }, {});
  fin("owner", "Do we have any quotes waiting on a customer?", `SELECT EXISTS (SELECT 1 FROM document_financials f WHERE f.doc_kind = 'estimate') AS v`, { cmp: "yesno", category: "existence" }, {}, "estimate");
  // -- per customer money (named)
  for (const name of NAMES.slice(0, 8)) {
    add("financials", "bookkeeper", `How much does ${name} owe us?`, (q) => {
      const s = subj(name, q);
      return { cmp: "number", sql: `SELECT coalesce(sum(${BAL}), 0) AS n FROM document_financials f WHERE ${INV} AND ${OPEN} AND f.document_id IN (${s.docs})`, requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND f.document_id IN (${s.docs})`, params: q.params },
        alt: { sql: `SELECT coalesce(sum(${BAL}), 0) AS n, lower(c.data->>'customer_name') AS says FROM entities c LEFT JOIN document_entity_links l ON l.entity_id = c.id LEFT JOIN document_financials f ON f.document_id = l.document_id AND ${INV} AND ${OPEN} WHERE c.id IN (${s.cust}) GROUP BY c.id, c.data`, params: q.params } };
    }, money);
  }
  for (const name of NAMES.slice(0, 6)) {
    add("financials", "owner", `How much have we invoiced ${name} in total?`, (q) => {
      const s = subj(name, q);
      return { cmp: "number", sql: `SELECT coalesce(sum(${TOTAL}), 0) AS n FROM document_financials f WHERE ${INV} AND f.document_id IN (${s.docs})`, requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND f.document_id IN (${s.docs})`, params: q.params },
        alt: { sql: `SELECT coalesce(sum(${TOTAL}), 0) AS n, lower(c.data->>'customer_name') AS says FROM entities c LEFT JOIN document_entity_links l ON l.entity_id = c.id LEFT JOIN document_financials f ON f.document_id = l.document_id AND ${INV} WHERE c.id IN (${s.cust}) GROUP BY c.id, c.data`, params: q.params } };
    }, money);
  }
  for (const name of NAMES.slice(0, 4)) {
    add("financials", "office", `Is ${name} all paid up?`, (q) => {
      const s = subj(name, q);
      return { cmp: "yesno", sql: `SELECT NOT EXISTS (SELECT 1 FROM document_financials f WHERE ${INV} AND ${OPEN} AND f.document_id IN (${s.docs})) AS v`, requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND f.document_id IN (${s.docs})`, params: q.params } };
    }, {});
  }
  for (const name of NAMES.slice(4, 8)) {
    add("financials", "bookkeeper", `When was the last invoice for ${name}?`, (q) => {
      const s = subj(name, q);
      return { cmp: "value", sql: `SELECT max(${IDATE})::text AS v FROM document_financials f WHERE ${INV} AND f.document_id IN (${s.docs})`, requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE ${INV} AND ${IDATE} IS NOT NULL AND f.document_id IN (${s.docs})`, params: q.params } };
    }, {});
  }
  add("financials", "owner", "Give me invoiced revenue month by month for this year", (q) => {
    const x = windowFor("this year", q);
    return { cmp: "rubric", rubric: "Lists invoiced revenue per month for the current year, consistent with the reference monthly totals (rounding to the dollar is fine; months with no invoices may be omitted).",
      sql: `SELECT to_char(m, 'YYYY-MM') || ': ' || sum_t AS ref FROM (SELECT date_trunc('month', ${IDATE}) AS m, sum(${TOTAL}) AS sum_t FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${x.start} AND ${IDATE} < ${x.end} GROUP BY 1) z ORDER BY 1`, requires: FIN_REQ("invoice") };
  }, { citeWhat: "the invoices behind the monthly totals" });

  /* ================================================================ CONTENT (only answerable by reading the document text) */
  // Reconciliation (round 5, R5_FAILS.md #1): "documents mention X" is a literal, honest raw scan of every
  // page (unchanged: TEXT_DOCS). "jobs mention X" means work actually done, same rule api/_lib/contentCount.js's
  // hasWorkMention/isVisitType enforce for Donovan's own answer: only visit-type documents count, and a bare
  // "Label: value" spec line (e.g. "Refrigerant: R-410A" on every startup sheet, "Tonnage: 3 tons" on a
  // nameplate) is excluded via the same negative-lookahead the Postgres regex engine supports natively.
  const TEXT_DOCS = (kw, q) => `SELECT DISTINCT p.document_id FROM document_pages p WHERE p.text ~* ${q.p(kw)}`;
  const TEXT_DOCS_JOBS = (kw, q) => `SELECT DISTINCT p.document_id FROM document_pages p JOIN documents d ON d.id = p.document_id WHERE p.text ~* ${q.p(`${kw}(?!\\s*:)`)} AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)})`;
  const JOBS_WORD_RE = /\bjobs?\b/i;
  const DOCS_WORD_RE = /\bdocuments?\b/i;
  const isJobsQuestion = (text) => JOBS_WORD_RE.test(text) && !DOCS_WORD_RE.test(text);
  const contentSet = (persona, text, kw, cat = "content", opts = {}) => {
    const docsSql = isJobsQuestion(text) ? TEXT_DOCS_JOBS : TEXT_DOCS;
    return add(cat, persona, text, (q) => ({
      cmp: "set", sql: `SELECT DISTINCT c.data->>'customer_name' AS item FROM document_entity_links l JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE l.document_id IN (${docsSql(kw, q)}) ORDER BY 1`,
      ...(opts.guard === false ? {} : { requires: { sql: `SELECT count(*) AS n FROM document_pages p WHERE p.text ~* $1`, params: [kw] } }),
    }), { maxItems: 25 });
  };
  const contentCount = (persona, text, kw, cat = "content", opts = {}) => {
    const docsSql = isJobsQuestion(text) ? TEXT_DOCS_JOBS : TEXT_DOCS;
    return add(cat, persona, text, (q) => ({
      cmp: "number", sql: `SELECT count(*) AS n FROM (${docsSql(kw, q)}) z`,
      ...(opts.guard === false ? {} : { requires: { sql: `SELECT count(*) AS n FROM document_pages p WHERE p.text ~* $1`, params: [kw] } }),
    }));
  };
  const CONCEPTS = [
    ["capacitor", "capacitor", "capacitor"],
    ["contactor", "contactor", "contactor"],
    ["refrigerant", "(refrigerant|freon|recharg|r-?410a|r-?22|r-?454b)", "refrigerant"],
    ["leak", "leak", "leak"],
    ["coil", "coil", "coil"],
    ["filter", "filter", "filter"],
    ["thermostat", "thermostat", "thermostat"],
    ["motor", "(blower|fan|condenser) motor", "motor"],
    ["drain", "(drain line|condensate|clog)", "drain problem"],
    ["ice", "(frozen|freez|iced|ice )", "freeze-up"],
  ];
  CONCEPTS.forEach(([, kw, label], i) => {
    contentCount(["tech", "office", "owner"][i % 3], `How many jobs mention a ${label}?`, kw);
    contentSet(["office", "tech", "owner"][i % 3], `Which customers had ${/^[aeiou]/.test(label) ? "an" : "a"} ${label} issue or repair on file?`, kw);
  });
  for (const [label, kw] of [["capacitor", "(replac\\w*[^.]{0,60}capacitor|capacitor[^.]{0,40}replac)"], ["contactor", "(replac\\w*[^.]{0,60}contactor|contactor[^.]{0,40}replac)"], ["motor", "(replac\\w*[^.]{0,60}motor|motor[^.]{0,40}replac)"], ["air filter", "(replac\\w*[^.]{0,40}filter|filter[^.]{0,30}replac|filter change)"]]) {
    contentSet("tech", `Which customers had the ${label} replaced?`, kw);
    contentCount("owner", `How many times have we replaced a ${label}?`, kw);
  }
  // honest "nothing on file" tests for things no document says (guard off: the expected answer is the zero)
  contentCount("tech", "How many jobs mention a compressor replacement?", "(replac\\w*[^.]{0,60}compressor|compressor[^.]{0,40}replac)", "content", { guard: false });
  contentCount("tech", "How many jobs involved a TXV or expansion valve?", "(txv|expansion valve)", "content", { guard: false });
  contentCount("tech", "How many jobs mention a heat exchanger crack?", "heat exchanger", "content", { guard: false });
  // rubric: what the text says about one named job (must cite the document)
  for (const name of NAMES.slice(0, 6)) {
    add("content", ["tech", "office"][NAMES.indexOf(name) % 2], `What was found or done on the ${name} job?`, (q) => {
      const s = subj(name, q);
      return { cmp: "rubric", rubric: "Reports what the documents for this customer actually say was found, replaced, checked or recommended, consistent with the reference; says nothing is on file if the reference is empty. No invented findings.",
        sql: `SELECT left(regexp_replace(p.text, '[[:space:]]+', ' ', 'g'), 240) AS ref FROM document_pages p WHERE p.document_id IN (${s.docs}) AND p.text ~* '(found|replac|check|recommend|repair|notes?:|finding)' ORDER BY p.created_at DESC LIMIT 6`,
        requires: { sql: `SELECT count(*) AS n FROM document_pages p WHERE p.document_id IN (${s.docs}) AND p.text ~* '(found|replac|check|recommend|repair|notes?:|finding)'`, params: q.params } };
    }, { citeWhat: "the service ticket / work order the finding came from" });
  }

  /* ================================================================ SEMANTIC (paraphrases of one symptom) */
  const SYMPTOMS = [
    ["(noise|noisy|loud|rattl|vibrat|humming|buzz|squeal|grind)", ["Which customers complained the unit is loud?", "Who called about a rattling or humming outdoor unit?", "How many jobs were for a noise complaint?"]],
    ["(not cooling|no cool|warm air|won'?t cool|blowing warm|not cold|isn'?t cooling|insufficient cool)", ["Which customers said their AC wasn't keeping up?", "Who had a no-cooling call?", "How many calls were for warm air coming out of the vents?"]],
    ["(leak|drip|water damage|puddle)", ["Which customers had water dripping from the unit?", "Who called about a leak?", "How many jobs mention a water leak?"]],
    ["(won'?t start|not starting|no power|tripp|breaker|not turning on|won'?t turn on)", ["Which customers had a unit that would not turn on?", "Who had a tripped breaker on the AC?", "How many calls were for a system that won't start?"]],
    ["(smell|odor|odour|burning)", ["Which customers reported a strange smell?", "Who complained about a burning odor from the vents?", "How many jobs mention an odor?"]],
  ];
  for (const [kw, phrasings] of SYMPTOMS) {
    phrasings.forEach((text, i) => {
      const persona = ["office", "tech", "owner"][i % 3];
      if (/^How many/.test(text)) contentCount(persona, text, kw, "semantic", { guard: false });
      else contentSet(persona, text, kw, "semantic", { guard: false });
    });
  }

  /* ================================================================ MULTI-HOP */
  const MH = (persona, text, kind, sql) => add("multi-hop", persona, text, (q) => ({ cmp: kind, sql: sql(q) }), kind === "set" ? { maxItems: 25 } : {});
  const namesOf = (where) => `SELECT c.data->>'customer_name' AS item FROM ${CUST} AND ${where} ORDER BY 1`;
  const countOf = (where) => `SELECT count(*) AS n FROM ${CUST} AND ${where}`;
  const yr = (q, n) => `(EXTRACT(YEAR FROM ${q.today()})::int - ${n})`;
  for (const brand of BRANDS.slice(0, 4)) {
    MH("owner", `Which customers have a ${brand} unit older than 10 years and no maintenance agreement?`, "set", (q) => namesOf(`${custUnit(` AND lower(e.data->>'manufacturer') = lower(${q.p(brand)}) AND ${installYear("e")} < ${yr(q, 10)}`)} AND NOT ${custDoc(agr(q))}`));
  }
  for (const brand of BRANDS.slice(0, 3)) {
    MH("owner", `How many ${brand} customers don't have a maintenance agreement?`, "number", (q) => countOf(`${custUnit(` AND lower(e.data->>'manufacturer') = lower(${q.p(brand)})`)} AND NOT ${custDoc(agr(q))}`));
  }
  MH("owner", "Which customers have an expired warranty and no maintenance agreement?", "set", (q) => namesOf(`${custUnit(` AND ${wstatus("e", q)} = 'expired'`)} AND NOT ${custDoc(agr(q))}`));
  MH("owner", "How many customers have an expired warranty but do have a maintenance agreement?", "number", (q) => countOf(`${custUnit(` AND ${wstatus("e", q)} = 'expired'`)} AND ${custDoc(agr(q))}`));
  MH("office", "Which customers have a warranty expiring in the next year and no maintenance agreement?", "set", (q) => namesOf(`${custUnit(` AND ${wstatus("e", q)} = 'expiring'`)} AND NOT ${custDoc(agr(q))}`));
  for (const city of CITIES.slice(0, 4)) {
    MH("office", `How many customers in ${city} have no maintenance agreement?`, "number", (q) => countOf(`lower(${GEO.city("(c.data->>'service_address')")}) = lower(${q.p(city)}) AND NOT ${custDoc(agr(q))}`));
  }
  MH("owner", "Which customers have a maintenance agreement but haven't had a service visit in the last 12 months?", "set", (q) => namesOf(`${custDoc(agr(q))} AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' LEFT JOIN entities le ON le.id = l.entity_id WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)}) AND ${ISO("y.value")} > ${q.today()} - 365 AND ${ISO("y.value")} <= ${q.today()})`));
  MH("owner", "How many customers have more than one unit?", "number", () => countOf(`(SELECT count(*) FROM ${EQUIP} AND e.customer_id = c.id) > 1`));
  MH("tech", "Which customers have units from two or more different brands?", "set", () => namesOf(`(SELECT count(DISTINCT lower(e.data->>'manufacturer')) FROM ${EQUIP} AND e.customer_id = c.id) >= 2`));
  MH("owner", "How many customers have been invoiced but never signed a maintenance agreement?", "number", (q) => countOf(`${custDoc(`${q.p(DOCTYPE_ALIASES.invoice)}`)} AND NOT ${custDoc(agr(q))}`));
  MH("office", "Which customers have no email but do have an expired warranty?", "set", (q) => namesOf(`coalesce(c.data->>'email', '') = '' AND ${custUnit(` AND ${wstatus("e", q)} = 'expired'`)}`));
  MH("tech", "How many customers have a unit older than 15 years and a permit on file?", "number", (q) => countOf(`${custUnit(` AND ${installYear("e")} < ${yr(q, 15)}`)} AND ${custDoc(`${q.p(DOCTYPE_ALIASES.permit)}`)}`));
  MH("owner", "How many customers with a Trane or Carrier unit have an active warranty?", "number", (q) => countOf(`${custUnit(` AND lower(e.data->>'manufacturer') IN ('trane','carrier') AND ${wstatus("e", q)} = 'active'`)}`));
  MH("office", "Which customers have both a permit and a maintenance agreement on file?", "set", (q) => namesOf(`${custDoc(`${q.p(DOCTYPE_ALIASES.permit)}`)} AND ${custDoc(agr(q))}`));
  MH("bookkeeper", "How many customers have a purchase order on file but no invoice?", "number", (q) => countOf(`${custDoc(`${q.p(DOCTYPE_ALIASES["purchase-order"])}`)} AND NOT ${custDoc(`${q.p(DOCTYPE_ALIASES.invoice)}`)}`));
  MH("owner", "Which customers with units older than 10 years have never had a service visit on file?", "set", (q) => namesOf(`${custUnit(` AND ${installYear("e")} < ${yr(q, 10)}`)} AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' LEFT JOIN entities le ON le.id = l.entity_id WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)}))`));

  /* ================================================================ TRENDS (owner) */
  const visitsIn = (w) => `(SELECT count(DISTINCT y.document_id || ${ISO("y.value")}::text) FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end})`;
  const TR_REQ = (q) => ({ sql: `SELECT count(*) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${q.today()} - 400`, params: q.params });
  for (const [text, a, b] of [
    ["Did we do more service calls last quarter than the quarter before?", "last quarter", "the quarter before last"],
    ["Are service calls up last quarter compared with the quarter before it?", "last quarter", "the quarter before last"],
    ["Did we run more jobs last month than the month before?", "last month", "the month before last"],
    ["Were service visits higher last month than two months ago?", "last month", "the month before last"],
  ]) {
    add("trends", "owner", text, (q) => { const wa = windowFor(a, q); const wb = windowFor(b, q); return { cmp: "yesno", sql: `SELECT ${visitsIn(wa)} > ${visitsIn(wb)} AS v`, requires: TR_REQ(q) }; });
  }
  add("trends", "owner", "Did we invoice more last month than the month before?", (q) => {
    const wa = windowFor("last month", q); const wb = windowFor("the month before last", q);
    const t = (w) => `(SELECT coalesce(sum(${TOTAL}), 0) FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${w.start} AND ${IDATE} < ${w.end})`;
    return { cmp: "yesno", sql: `SELECT ${t(wa)} > ${t(wb)} AS v`, requires: FIN_REQ("invoice") };
  });
  add("trends", "owner", "Is invoiced revenue higher last quarter than the quarter before?", (q) => {
    const wa = windowFor("last quarter", q); const wb = windowFor("the quarter before last", q);
    const t = (w) => `(SELECT coalesce(sum(${TOTAL}), 0) FROM document_financials f WHERE ${INV} AND ${IDATE} >= ${w.start} AND ${IDATE} < ${w.end})`;
    return { cmp: "yesno", sql: `SELECT ${t(wa)} > ${t(wb)} AS v`, requires: FIN_REQ("invoice") };
  });
  add("trends", "owner", "Did we install more units last year than the year before?", (q) => ({ cmp: "yesno", sql: `SELECT (SELECT count(*) FROM ${EQUIP} AND ${installYear("e")} = ${yr(q, 1)}) > (SELECT count(*) FROM ${EQUIP} AND ${installYear("e")} = ${yr(q, 2)}) AS v`, requires: { sql: `SELECT count(*) AS n FROM ${EQUIP} AND ${installYear("e")} IS NOT NULL`, params: [] } }));
  add("trends", "owner", "Which month had the most service calls this year?", (q) => {
    const w = windowFor("this year", q);
    return { cmp: "value", sql: `SELECT to_char(g.m, 'FMMonth') AS v FROM (SELECT date_trunc('month', ${ISO("y.value")}) AS m, count(DISTINCT y.document_id || ${ISO("y.value")}::text) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end} GROUP BY 1) g WHERE g.n = (SELECT max(n) FROM (SELECT count(DISTINCT y.document_id || ${ISO("y.value")}::text) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end} GROUP BY date_trunc('month', ${ISO("y.value")})) h)`, requires: { sql: `SELECT count(*) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`, params: q.params } };
  });
  add("trends", "owner", "How have our monthly service calls changed this year?", (q) => {
    const w = windowFor("this year", q);
    return { cmp: "rubric", rubric: "Describes the month-by-month direction of service calls this year (up, down or flat) consistent with the monthly reference counts; does not invent months.",
      sql: `SELECT to_char(g.m, 'YYYY-MM') || ': ' || g.n || ' calls' AS ref FROM (SELECT date_trunc('month', ${ISO("y.value")}) AS m, count(DISTINCT y.document_id || ${ISO("y.value")}::text) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end} GROUP BY 1) g ORDER BY g.m`, requires: { sql: `SELECT count(*) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`, params: q.params } };
  }, { citeWhat: "the service documents counted" });

  /* ================================================================ RANKINGS */
  // ties: every group holding the maximum (or minimum) is an accepted answer
  const topOf = (inner, dir = "max") => `WITH g AS (${inner}) SELECT k AS v FROM g WHERE k IS NOT NULL AND n = (SELECT ${dir}(n) FROM g WHERE k IS NOT NULL)`;
  const RK = (persona, text, sql, req) => add("rankings", persona, text, (q) => ({ cmp: "value", sql: sql(q), ...(req ? { requires: req(q) } : {}) }));
  const custBy = (n, extraJoin, where) => `SELECT c.data->>'customer_name' AS k, ${n} AS n FROM ${extraJoin} WHERE c.entity_type = 'customer' AND c.merged_into IS NULL${where ?? ""} GROUP BY c.id, c.data`;
  RK("owner", "Which customer has the most units?", () => topOf(custBy("count(*)", "entities c JOIN entities e ON e.customer_id = c.id AND e.entity_type = 'equipment' AND e.merged_into IS NULL")));
  RK("owner", "Which customer has the most documents on file?", () => topOf(custBy("count(DISTINCT l.document_id)", "entities c JOIN document_entity_links l ON l.entity_id = c.id")));
  RK("owner", "Which customer have we been out to the most times?", (q) => topOf(custBy(`count(DISTINCT ${ISO("y.value")})`, `entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_date' JOIN documents d ON d.id = y.document_id`, ` AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)}) AND ${ISO("y.value")} <= ${q.today()}`)));
  for (const [text, key] of [["Which city has the most customers?", "city"], ["Which zip code has the most customers?", "zip"], ["Which state do most of our customers live in?", "state"]]) {
    RK("owner", text, () => topOf(`SELECT ${GEO[key]("(c.data->>'service_address')")} AS k, count(*) AS n FROM ${CUST} GROUP BY 1`));
  }
  RK("owner", "What's our most common brand?", () => topOf(`SELECT lower(e.data->>'manufacturer') AS k, count(*) AS n FROM ${EQUIP} GROUP BY 1`));
  RK("tech", "Which brand do we have the fewest units of?", () => topOf(`SELECT lower(e.data->>'manufacturer') AS k, count(*) AS n FROM ${EQUIP} GROUP BY 1`, "min"));
  RK("owner", "Which brand has the most out-of-warranty units?", (q) => topOf(`SELECT lower(e.data->>'manufacturer') AS k, count(*) AS n FROM ${EQUIP} AND ${wstatus("e", q)} = 'expired' GROUP BY 1`));
  RK("tech", "What's the most common unit model we service?", () => topOf(`SELECT upper(e.data->>'model') AS k, count(*) AS n FROM ${EQUIP} GROUP BY 1`));
  RK("tech", "What tonnage do we see most often?", () => topOf(`SELECT e.data->>'tonnage' AS k, count(*) AS n FROM ${EQUIP} GROUP BY 1`));
  RK("owner", "Which customer has the oldest unit?", () => `SELECT c.data->>'customer_name' AS v FROM ${EQUIP.replace("WHERE", "JOIN entities c ON c.id = e.customer_id WHERE")} AND ${installYear("e")} = (SELECT min(${installYear("e")}) FROM ${EQUIP})`);
  RK("owner", "Who has our newest installed unit?", (q) => `SELECT c.data->>'customer_name' AS v FROM ${EQUIP.replace("WHERE", "JOIN entities c ON c.id = e.customer_id WHERE")} AND ${installYear("e")} = (SELECT max(${installYear("e")}) FROM ${EQUIP} AND ${installYear("e")} <= EXTRACT(YEAR FROM ${q.today()})::int)`);
  RK("owner", "Which document type do we have the most of?", () => topOf(`SELECT ${DOCTYPE("d.document_type")} AS k, count(*) AS n FROM documents d GROUP BY 1`));
  RK("office", "Which document type do we have the fewest of?", () => topOf(`SELECT ${DOCTYPE("d.document_type")} AS k, count(*) AS n FROM documents d GROUP BY 1`, "min"));
  RK("owner", "Which customer has the most expired warranties?", (q) => topOf(custBy("count(*)", "entities c JOIN entities e ON e.customer_id = c.id AND e.entity_type = 'equipment' AND e.merged_into IS NULL", ` AND ${wstatus("e", q)} = 'expired'`)),
    (q) => ({ sql: `SELECT count(*) AS n FROM ${EQUIP} AND ${wstatus("e", q)} = 'expired'` }));
  RK("bookkeeper", "Which customer has the largest single invoice?", () => `SELECT c.data->>'customer_name' AS v FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE ${INV} AND ${TOTAL} = (SELECT max(${TOTAL}) FROM document_financials f WHERE ${INV})`, () => FIN_REQ("invoice"));
  RK("owner", "Which year did we install the most units?", () => topOf(`SELECT ${installYear("e")}::text AS k, count(*) AS n FROM ${EQUIP} GROUP BY 1`));

  /* ================================================================ TECH PERFORMANCE */
  // a job = a document with a service_date; its technician is the document's own technician extraction
  const techWhere = (pat, extra = "") => `FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' WHERE t.field_key = 'technician' AND t.value ILIKE ${pat}${extra}`;
  const techReq = (tech) => ({ sql: `SELECT count(*) AS n FROM extractions t WHERE t.field_key = 'technician' AND t.value ILIKE $1`, params: [`%${esc(tech)}%`] });
  for (const tech of TECHS) {
    add("tech-performance", "office", `How many jobs has ${tech} done in total?`, (q) => ({ cmp: "number", sql: `SELECT count(DISTINCT t.document_id) AS n ${techWhere(q.p(`%${esc(tech)}%`))}`, requires: techReq(tech) }));
  }
  for (const tech of TECHS.slice(0, 4)) {
    add("tech-performance", "owner", `How many jobs did ${tech} run this year?`, (q) => { const pat = q.p(`%${esc(tech)}%`); const w = windowFor("this year", q); return { cmp: "number", sql: `SELECT count(DISTINCT t.document_id) AS n ${techWhere(pat, ` AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`)}`, requires: techReq(tech) }; });
  }
  for (const tech of TECHS.slice(0, 4)) {
    add("tech-performance", "owner", `How many different customers has ${tech} worked for?`, (q) => ({ cmp: "number", sql: `SELECT count(DISTINCT c.id) AS n FROM extractions t JOIN document_entity_links l ON l.document_id = t.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE t.field_key = 'technician' AND t.value ILIKE ${q.p(`%${esc(tech)}%`)}`, requires: techReq(tech) }));
  }
  for (const tech of TECHS.slice(0, 3)) {
    add("tech-performance", "office", `When was ${tech}'s most recent job?`, (q) => ({ cmp: "value", sql: `SELECT max(${ISO("y.value")})::text AS v ${techWhere(q.p(`%${esc(tech)}%`), ` AND ${ISO("y.value")} <= ${q.today()}`)}`, requires: techReq(tech) }));
  }
  const techCustomers = `SELECT t.value AS k, count(DISTINCT c.id) AS n FROM extractions t JOIN document_entity_links l ON l.document_id = t.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' GROUP BY t.value`;
  add("tech-performance", "owner", "Which technician has worked for the most different customers?", () => ({ cmp: "value", sql: topOf(techCustomers) }));
  add("tech-performance", "owner", "Who's our busiest technician this year?", (q) => {
    const w = windowFor("this year", q);
    const j = `FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`;
    return { cmp: "value", sql: topOf(`SELECT t.value AS k, count(DISTINCT t.document_id) AS n ${j} GROUP BY t.value`), requires: { sql: `SELECT count(*) AS n ${j}` } };
  });
  add("tech-performance", "owner", "How many service jobs have no technician assigned?", () => ({ cmp: "number", sql: `SELECT count(DISTINCT y.document_id) AS n FROM extractions y WHERE y.field_key = 'service_date' AND NOT EXISTS (SELECT 1 FROM extractions t WHERE t.document_id = y.document_id AND t.field_key = 'technician' AND coalesce(t.value, '') <> '')` }));
  add("tech-performance", "owner", "How many technicians do we have on record?", () => ({ cmp: "number", sql: `SELECT count(DISTINCT lower(btrim(t.value))) AS n FROM extractions t WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> ''` }));
  add("tech-performance", "owner", "List our technicians and how many jobs each has done", () => ({ cmp: "set", sql: `SELECT t.value || '|' || count(DISTINCT t.document_id) AS item FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' GROUP BY t.value ORDER BY 1` }), { maxItems: 25 });

  /* ================================================================ DATA QUALITY */
  const DQ = (persona, text, cmp, sql, req) => add("data-quality", persona, text, (q) => ({ cmp, sql: typeof sql === "function" ? sql(q) : sql, ...(req ? { requires: req } : {}) }), cmp === "set" ? { maxItems: 25 } : {});
  DQ("office", "How many documents aren't linked to any customer?", "number", `SELECT count(*) AS n FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN entities x ON x.id = l.entity_id WHERE l.document_id = d.id AND x.entity_type = 'customer')`);
  DQ("office", "Are there documents missing a customer?", "yesno", `SELECT EXISTS (SELECT 1 FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN entities x ON x.id = l.entity_id WHERE l.document_id = d.id AND x.entity_type = 'customer')) AS v`);
  DQ("office", "How many customers have no documents on file?", "number", `SELECT count(*) AS n FROM ${CUST} AND NOT EXISTS (SELECT 1 FROM document_entity_links l WHERE l.entity_id = c.id)`);
  DQ("office", "How many customers have no phone number?", "number", `SELECT count(*) AS n FROM ${CUST} AND coalesce(c.data->>'phone', '') = ''`);
  DQ("office", "How many customers have no service address on file?", "number", `SELECT count(*) AS n FROM ${CUST} AND coalesce(c.data->>'service_address', '') = ''`);
  DQ("office", "How many customer addresses are missing a zip code?", "number", `SELECT count(*) AS n FROM ${CUST} AND coalesce(c.data->>'service_address', '') <> '' AND c.data->>'service_address' !~ '[0-9]{5}([[:space:]-]*[0-9]{4})?[[:space:]]*$'`);
  DQ("tech", "How many units are missing a serial number?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND coalesce(e.data->>'serial_number', '') = ''`);
  DQ("tech", "How many units have no install date on file?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND coalesce(e.data->>'installation_date', '') = ''`);
  DQ("tech", "How many units don't have a model number recorded?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND coalesce(e.data->>'model', '') = ''`);
  DQ("tech", "How many units have no tonnage on file?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND coalesce(e.data->>'tonnage', '') = ''`);
  DQ("owner", "How many units have no warranty information at all?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND (e.data->'warranty'->>'expires') IS NULL`);
  DQ("tech", "How many units are not linked to a customer?", "number", `SELECT count(*) AS n FROM ${EQUIP} AND e.customer_id IS NULL`);
  DQ("owner", "How many units have an install date in the future?", "number", (q) => `SELECT count(*) AS n FROM ${EQUIP} AND ${installYear("e")} > EXTRACT(YEAR FROM ${q.today()})::int`);
  DQ("office", "Do we have any duplicate customers?", "yesno", `SELECT EXISTS (SELECT 1 FROM ${CUST} AND (SELECT count(*) FROM entities c2 WHERE c2.entity_type = 'customer' AND c2.merged_into IS NULL AND lower(btrim(c2.data->>'customer_name')) = lower(btrim(c.data->>'customer_name'))) > 1) AS v`);
  DQ("office", "Which customers appear more than once in our records?", "set", `SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST} AND (SELECT count(*) FROM entities c2 WHERE c2.entity_type = 'customer' AND c2.merged_into IS NULL AND lower(btrim(c2.data->>'customer_name')) = lower(btrim(c.data->>'customer_name'))) > 1 ORDER BY 1`);
  DQ("office", "How many customers share an address with another customer?", "number", `SELECT count(*) AS n FROM ${CUST} AND coalesce(c.data->>'service_address', '') <> '' AND (SELECT count(*) FROM entities c2 WHERE c2.entity_type = 'customer' AND c2.merged_into IS NULL AND lower(btrim(c2.data->>'service_address')) = lower(btrim(c.data->>'service_address'))) > 1`);
  DQ("office", "How many documents are classified as 'other' instead of a real type?", "number", `SELECT count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} IN ('other', 'unknown', 'unclassified')`);
  DQ("office", "How many documents have no readable text extracted?", "number", `SELECT count(*) AS n FROM documents d WHERE NOT EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND coalesce(p.text, '') <> '')`);
  DQ("office", "How many service documents have no service date?", "number", (q) => `SELECT count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${vt(q)}) AND NOT EXISTS (SELECT 1 FROM extractions y WHERE y.document_id = d.id AND y.field_key = 'service_date' AND coalesce(y.value, '') <> '')`);
  DQ("tech", "Are any serial numbers used by more than one unit?", "yesno", `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND coalesce(e.data->>'serial_number', '') <> '' AND (SELECT count(*) FROM entities e2 WHERE e2.entity_type = 'equipment' AND e2.merged_into IS NULL AND upper(e2.data->>'serial_number') = upper(e.data->>'serial_number')) > 1) AS v`);
  DQ("owner", "How many customers have both a phone and an email on file?", "number", `SELECT count(*) AS n FROM ${CUST} AND coalesce(c.data->>'phone', '') <> '' AND coalesce(c.data->>'email', '') <> ''`);

  /* ================================================================ EXISTENCE (yes / no) */
  const EX = (persona, text, sql) => add("existence", persona, text, (q) => ({ cmp: "yesno", sql: typeof sql === "function" ? sql(q) : sql }));
  for (const brand of ["Mitsubishi", "Daikin", "York", "Rheem", "Ruud", "Bryant", "American Standard", "Amana"]) {
    EX("tech", `Do we have any ${brand} units?`, (q) => `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND lower(e.data->>'manufacturer') = lower(${q.p(brand)})) AS v`);
  }
  for (const city of ["Las Vegas", "Casa Grande", "Scottsdale", "Flagstaff", "Chandler"]) {
    EX("office", `Do we have any customers in ${city}?`, (q) => `SELECT EXISTS (SELECT 1 FROM ${CUST} AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${q.p(city)})) AS v`);
  }
  EX("owner", "Do we have any units with an expired warranty?", (q) => `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND ${wstatus("e", q)} = 'expired') AS v`);
  EX("owner", "Do we have any units older than 20 years?", (q) => `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND ${installYear("e")} < ${yr(q, 20)}) AS v`);
  EX("office", "Is there a maintenance agreement on file for anyone?", (q) => `SELECT EXISTS (SELECT 1 FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${agr(q)})) AS v`);
  EX("office", "Do we have any permits on file?", (q) => `SELECT EXISTS (SELECT 1 FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES.permit)}::text[])) AS v`);
  EX("bookkeeper", "Do we have any purchase orders on file?", (q) => `SELECT EXISTS (SELECT 1 FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES["purchase-order"])}::text[])) AS v`);
  EX("owner", "Did we do any service calls last month?", (q) => { const w = windowFor("last month", q); return `SELECT EXISTS (SELECT 1 FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}) AS v`; });
  EX("owner", "Do we have any customers with three or more units?", () => `SELECT EXISTS (SELECT 1 FROM ${CUST} AND (SELECT count(*) FROM ${EQUIP} AND e.customer_id = c.id) >= 3) AS v`);
  EX("tech", "Do we have any nameplate photos on file?", (q) => `SELECT EXISTS (SELECT 1 FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES["nameplate-photo"])}::text[])) AS v`);
  EX("tech", "Do we have a unit that runs on R-22?", () => `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND upper(replace(coalesce(e.data->>'refrigerant', ''), '-', '')) = 'R22') AS v`);

  /* ================================================================ EXPLAIN / WHY (rubric, must cite) */
  const WHY = (persona, text, cite, rubric, name, refOf, guardOf) => add("explain", persona, text, (q) => {
    const s = subj(name, q);
    return { cmp: "rubric", rubric, sql: refOf(q, s), requires: { sql: guardOf(q, s) } };
  }, { citeWhat: cite });
  for (const name of NAMES.slice(0, 4)) {
    WHY("office", `Why is the ${name} unit flagged for a warranty alert?`, "the unit's warranty record (expiry date) or the warranty document", "Explains the warranty status of this customer's unit(s) with the actual dates (install date, warranty expiry) from the reference; says so if no warranty date is on file. No invented dates.", name,
      (q, s) => `SELECT coalesce(e.data->>'manufacturer', '') || ' ' || coalesce(e.data->>'model', '') || ' installed ' || coalesce(e.data->>'installation_date', 'unknown') || ', warranty expires ' || coalesce(e.data->'warranty'->>'expires', 'not on file') || ' (' || ${wstatus("e", q)} || ')' AS ref FROM entities e WHERE e.id IN (${s.equip})`,
      (_q, s) => `SELECT count(*) AS n FROM entities e WHERE e.id IN (${s.equip})`);
  }
  for (const name of NAMES.slice(4, 8)) {
    const visit = (q, s) => `FROM extractions y JOIN documents d ON d.id = y.document_id WHERE y.field_key = 'service_date' AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)}) AND ${ISO("y.value")} <= ${q.today()} AND y.document_id IN (${s.docs})`;
    WHY("tech", `Explain what happened at ${name}'s last service visit`, "the service document for that visit", "Describes the most recent service visit for this customer (date and what was done or found) consistent with the reference; must not describe a different visit or invent work.", name,
      (q, s) => `SELECT ${ISO("y.value")}::text || ' | ' || d.original_filename || ' | ' || left(regexp_replace(coalesce((SELECT string_agg(p.text, ' ') FROM document_pages p WHERE p.document_id = d.id), ''), '[[:space:]]+', ' ', 'g'), 220) AS ref ${visit(q, s)} ORDER BY ${ISO("y.value")} DESC LIMIT 2`,
      (q, s) => `SELECT count(*) AS n ${visit(q, s)}`);
  }
  for (const name of NAMES.slice(8, 12)) {
    const FU = "(follow[- ]?up|recommend|approve|pending|schedule|next visit|due)";
    WHY("owner", `Why would ${name} need a follow-up?`, "the document that mentions the follow-up, note or recommendation", "Gives a reason for follow-up grounded in the customer's documents (a recommendation, unfinished repair, expiring warranty or overdue service) consistent with the reference; says nothing on file if the reference is empty.", name,
      (_q, s) => `SELECT left(regexp_replace(p.text, '[[:space:]]+', ' ', 'g'), 240) AS ref FROM document_pages p WHERE p.document_id IN (${s.docs}) AND p.text ~* '${FU}' ORDER BY p.created_at DESC LIMIT 4`,
      (_q, s) => `SELECT count(*) AS n FROM document_pages p WHERE p.document_id IN (${s.docs}) AND p.text ~* '${FU}'`);
  }

  /* ================================================================ PERSONA (self-contained, conversational) */
  for (const [brand, city, persona] of [["Trane", "Mesa", "office"], ["Carrier", "Tucson", "owner"], ["Goodman", "Chandler", "office"], ["Lennox", "Gilbert", "tech"], ["Rheem", "Mesa", "tech"], ["Trane", "Tucson", "owner"]]) {
    add("persona", persona, `Of our ${brand} customers, how many are in ${city}?`, (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${CUST} AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${q.p(city)}) AND ${custUnit(` AND lower(e.data->>'manufacturer') = lower(${q.p(brand)})`)}` }));
  }
  add("persona", "bookkeeper", "Which customers have a PO on file?", (q) => ({ cmp: "set", sql: namesOf(custDoc(`${q.p(DOCTYPE_ALIASES["purchase-order"])}`)) }), { maxItems: 25 });
  add("persona", "bookkeeper", "How many customers have a permit on file?", (q) => ({ cmp: "number", sql: countOf(custDoc(`${q.p(DOCTYPE_ALIASES.permit)}`)) }));
  add("persona", "office", "Which customers in Gilbert have a maintenance agreement?", (q) => ({ cmp: "set", sql: namesOf(`lower(${GEO.city("(c.data->>'service_address')")}) = 'gilbert' AND ${custDoc(agr(q))}`) }), { maxItems: 25 });
  add("persona", "office", "Which Tucson customers don't have a phone number on file?", () => ({ cmp: "set", sql: namesOf(`lower(${GEO.city("(c.data->>'service_address')")}) = 'tucson' AND coalesce(c.data->>'phone', '') = ''`) }), { maxItems: 25 });
  add("persona", "tech", "How many units in Mesa are older than 10 years?", (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${EQUIP} AND lower(${GEO.city("COALESCE(e.data->>'service_address', (SELECT c0.data->>'service_address' FROM entities c0 WHERE c0.id = e.customer_id))")}) = 'mesa' AND ${installYear("e")} < ${yr(q, 10)}` }));
  add("persona", "tech", "How many Goodman units are out of warranty?", (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${EQUIP} AND lower(e.data->>'manufacturer') = 'goodman' AND ${wstatus("e", q)} = 'expired'` }));
  add("persona", "owner", "How many customers do we have in total?", () => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${CUST}` }));
  add("persona", "owner", "How many units are we tracking?", () => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${EQUIP}` }));
  add("persona", "office", "How many service tickets do we have on file?", (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES["service-ticket"])}::text[])` }));
  add("persona", "office", "How many work orders do we have?", (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES["work-order"])}::text[])` }));
  add("persona", "owner", "How many units have a warranty expiring in the next year?", (q) => ({ cmp: "number", sql: `SELECT count(*) AS n FROM ${EQUIP} AND ${wstatus("e", q)} = 'expiring'` }));
  add("persona", "owner", "What percent of our units are out of warranty?", (q) => ({ cmp: "number", sql: `SELECT round(100.0 * count(*) FILTER (WHERE ${wstatus("e", q)} = 'expired') / nullif(count(*), 0)) AS n FROM ${EQUIP}` }), { tolerance: 1, anyNumber: true });

  /* ================================================================ CONNECT-THE-DOTS (TEAM T3, 2026-09-25)
   * "Is Donovan as good as Claude with full access to the documents?" - the new yardstick needs questions
   * that CANNOT be answered from one row of one table: a unit's install date against its later visits, a
   * quote's own wording against what was actually invoiced, a technician's job against a same-customer
   * follow-up a different document recorded weeks later, an entity's own field against what a document's
   * text actually says. Same discipline as MULTI-HOP above: an independent oracle over the base tables
   * (entities, documents, extractions, document_pages, document_financials, document_entity_links), no
   * shared code with Donovan. A "job"/"visit" here is the same VISIT_TYPES-gated, service_date-bearing
   * document every other family in this file already uses (lastService/visitCount/serviced/multi-hop).
   */
  const CQ = (cmp, text, persona, build, flags = {}) => add("connect", persona, text, (q) => {
    const r = build(q);
    return typeof r === "string" ? { cmp, sql: r } : { cmp, ...r };
  }, cmp === "set" ? { maxItems: 25, ...flags } : flags);

  // Every visit (a VISIT_TYPES document with its own service_date, dated on or before today), resolved to
  // its CUSTOMER whether the document was linked to the customer directly or to one of their units, plus
  // that document's own technician extraction (null if it has none). Used as a CTE ("WITH v AS (...)") so a
  // question can self-join it (a visit against another visit) without re-running the same join twice.
  const VISIT_ROWS = (q) => `SELECT c.id AS cust_id, d.id AS doc_id, ${ISO("y.value")} AS dt,
      (SELECT t.value FROM extractions t WHERE t.document_id = d.id AND t.field_key = 'technician' LIMIT 1) AS tech
    FROM document_entity_links l JOIN documents d ON d.id = l.document_id
    LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
    JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer' AND c.merged_into IS NULL
    JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date'
    WHERE ${DOCTYPE("d.document_type")} = ANY(${vt(q)}) AND ${ISO("y.value")} <= ${q.today()}`;
  const INSTALL_DATE = (e) => `(CASE WHEN ${e}.data->>'installation_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(${e}.data->>'installation_date', 1, 10)::date END)`;
  const REPLACE_RE = (word) => `(replac\\w*[^.]{0,60}${word}|${word}[^.]{0,40}replac)`;

  /* ---- repeat failures: another visit soon after a unit was installed */
  for (const days of [30, 90, 180]) {
    CQ("set", `Which customers had another service visit within ${days} days of a unit's installation?`, "owner", (q) => `SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST} AND EXISTS (
        SELECT 1 FROM ${EQUIP} AND e.customer_id = c.id AND ${INSTALL_DATE("e")} IS NOT NULL
          AND EXISTS (SELECT 1 FROM (${VISIT_ROWS(q)}) vv WHERE vv.cust_id = c.id AND vv.dt > ${INSTALL_DATE("e")} AND vv.dt <= ${INSTALL_DATE("e")} + ${days})
      ) ORDER BY 1`);
    CQ("number", `How many units had a repeat visit within ${days} days of installation?`, "tech", (q) => `SELECT count(*) AS n FROM ${EQUIP} AND ${INSTALL_DATE("e")} IS NOT NULL
        AND EXISTS (SELECT 1 FROM (${VISIT_ROWS(q)}) vv WHERE vv.cust_id = e.customer_id AND vv.dt > ${INSTALL_DATE("e")} AND vv.dt <= ${INSTALL_DATE("e")} + ${days})`);
  }
  for (const brand of BRANDS) {
    CQ("number", `How many ${brand} units had a repeat visit within 90 days of installation?`, "tech", (q) => {
      const b = q.p(brand);
      return `SELECT count(*) AS n FROM ${EQUIP} AND lower(e.data->>'manufacturer') = lower(${b}) AND ${INSTALL_DATE("e")} IS NOT NULL
        AND EXISTS (SELECT 1 FROM (${VISIT_ROWS(q)}) vv WHERE vv.cust_id = e.customer_id AND vv.dt > ${INSTALL_DATE("e")} AND vv.dt <= ${INSTALL_DATE("e")} + 90)`;
    });
  }
  for (const name of NAMES.slice(0, 8)) {
    CQ("yesno", `Did ${name} have a repeat visit within 90 days of installing a unit?`, "office", (q) => {
      const s = subj(name, q);
      return { sql: `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND e.customer_id IN (${s.cust}) AND ${INSTALL_DATE("e")} IS NOT NULL
          AND EXISTS (SELECT 1 FROM (${VISIT_ROWS(q)}) vv WHERE vv.cust_id = e.customer_id AND vv.dt > ${INSTALL_DATE("e")} AND vv.dt <= ${INSTALL_DATE("e")} + 90)) AS v`, requires: { sql: s.req }, scope: { sql: s.docs } };
    });
  }

  /* ---- callbacks: a second visit soon after an earlier one (same customer), and per-technician versions */
  for (const days of [14, 30, 60]) {
    CQ("set", `Which customers had a callback within ${days} days of a previous service visit?`, "office", (q) => `WITH v AS (${VISIT_ROWS(q)}) SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST}
      AND EXISTS (SELECT 1 FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt > a.dt AND b.dt <= a.dt + ${days} WHERE a.cust_id = c.id) ORDER BY 1`);
    CQ("number", `How many customers had a callback within ${days} days of a service visit?`, "owner", (q) => `WITH v AS (${VISIT_ROWS(q)}) SELECT count(DISTINCT a.cust_id) AS n FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt > a.dt AND b.dt <= a.dt + ${days}`);
  }
  for (const city of CITIES.slice(0, 4)) {
    CQ("set", `Which customers in ${city} had a callback within 30 days of a service visit?`, "office", (q) => {
      const c = q.p(city);
      return `WITH v AS (${VISIT_ROWS(q)}) SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST}
        AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c})
        AND EXISTS (SELECT 1 FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt > a.dt AND b.dt <= a.dt + 30 WHERE a.cust_id = c.id) ORDER BY 1`;
    });
  }
  for (const tech of TECHS) {
    CQ("number", `How many of ${tech}'s jobs had a callback within 30 days?`, "office", (q) => {
      const pat = q.p(`%${esc(tech)}%`);
      return { sql: `WITH v AS (${VISIT_ROWS(q)}) SELECT count(DISTINCT a.doc_id) AS n FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt > a.dt AND b.dt <= a.dt + 30 WHERE a.tech ILIKE ${pat}`, requires: techReq(tech) };
    });
  }
  CQ("set", "Which technicians have had a callback within 30 days on one of their jobs?", "owner", (q) => `WITH v AS (${VISIT_ROWS(q)}) SELECT DISTINCT a.tech AS item FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt > a.dt AND b.dt <= a.dt + 30 WHERE coalesce(a.tech, '') <> '' ORDER BY 1`);

  /* ---- two different technicians on the same customer within a short window (a handoff or a re-check) */
  for (const days of [14, 30]) {
    CQ("set", `Which customers had two different technicians visit within ${days} days of each other?`, "office", (q) => `WITH v AS (${VISIT_ROWS(q)}) SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST}
      AND EXISTS (SELECT 1 FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt >= a.dt AND b.dt <= a.dt + ${days} AND coalesce(a.tech, '') <> '' AND coalesce(b.tech, '') <> '' AND lower(a.tech) <> lower(b.tech) WHERE a.cust_id = c.id) ORDER BY 1`);
    CQ("number", `How many customers had two different technicians visit within ${days} days of each other?`, "owner", (q) => `WITH v AS (${VISIT_ROWS(q)}) SELECT count(DISTINCT a.cust_id) AS n FROM v a JOIN v b ON b.cust_id = a.cust_id AND b.doc_id <> a.doc_id AND b.dt >= a.dt AND b.dt <= a.dt + ${days} AND coalesce(a.tech, '') <> '' AND coalesce(b.tech, '') <> '' AND lower(a.tech) <> lower(b.tech)`);
  }

  /* ---- quoted a replacement, never got one */
  const REPL_KW = "(replac\\w*\\s+(the\\s+)?(unit|system|equipment|condenser|furnace|ac)|new (unit|system)|full replacement|system replacement)";
  const quotedNoReplacement = (extra = "") => (q) => {
    const kw = q.p(REPL_KW); const qt = q.p(DOCTYPE_ALIASES["proposal-quote"]);
    return `${extra} EXISTS (
        SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id JOIN document_pages p ON p.document_id = d.id
        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
        WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND ${DOCTYPE("d.document_type")} = ANY(${qt}::text[]) AND p.text ~* ${kw}
      ) AND NOT EXISTS (
        SELECT 1 FROM ${EQUIP} AND e.customer_id = c.id AND ${INSTALL_DATE("e")} IS NOT NULL AND ${INSTALL_DATE("e")} > (
          SELECT min(d2.created_at::date) FROM document_entity_links l2 JOIN documents d2 ON d2.id = l2.document_id LEFT JOIN entities le2 ON le2.id = l2.entity_id AND le2.entity_type = 'equipment'
          WHERE (l2.entity_id = c.id OR le2.customer_id = c.id) AND ${DOCTYPE("d2.document_type")} = ANY(${qt}::text[])
        )
      )`;
  };
  CQ("set", "Which customers were quoted a replacement but have not had a new unit installed since?", "owner", (q) => `SELECT DISTINCT c.data->>'customer_name' AS item FROM ${CUST} AND ${quotedNoReplacement()(q)} ORDER BY 1`);
  CQ("number", "How many customers were quoted a replacement but never got one?", "bookkeeper", (q) => `SELECT count(*) AS n FROM ${CUST} AND ${quotedNoReplacement()(q)}`);
  for (const city of CITIES.slice(0, 4)) {
    CQ("number", `How many ${city} customers were quoted a replacement but have only had repairs since?`, "office", (q) => {
      const c = q.p(city);
      return `SELECT count(*) AS n FROM ${CUST} AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c}) AND ${quotedNoReplacement()(q)}`;
    });
  }

  /* ---- warranty registration missing despite an install well in the past */
  const noWarrantyReg = (q) => {
    const wt = q.p(DOCTYPE_ALIASES["warranty-registration"]);
    return `NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id WHERE l.entity_id = e.id AND ${DOCTYPE("d.document_type")} = ANY(${wt}::text[]))
      AND NOT EXISTS (SELECT 1 FROM document_entity_links l2 JOIN documents d2 ON d2.id = l2.document_id WHERE l2.entity_id = e.customer_id AND ${DOCTYPE("d2.document_type")} = ANY(${wt}::text[]))`;
  };
  CQ("set", "Which units were installed more than 90 days ago but have no warranty registration on file?", "office", (q) => `SELECT DISTINCT c.data->>'customer_name' AS item FROM ${EQUIP.replace("WHERE", "JOIN entities c ON c.id = e.customer_id WHERE")}
      AND ${INSTALL_DATE("e")} IS NOT NULL AND ${INSTALL_DATE("e")} <= ${q.today()} - 90 AND ${noWarrantyReg(q)} ORDER BY 1`);
  CQ("number", "How many units were installed more than 90 days ago with no warranty registration on file?", "office", (q) => `SELECT count(*) AS n FROM ${EQUIP} AND ${INSTALL_DATE("e")} IS NOT NULL AND ${INSTALL_DATE("e")} <= ${q.today()} - 90 AND ${noWarrantyReg(q)}`);
  for (const brand of BRANDS) {
    CQ("number", `How many ${brand} units installed more than 90 days ago have no warranty registration on file?`, "tech", (q) => {
      const b = q.p(brand);
      return `SELECT count(*) AS n FROM ${EQUIP} AND lower(e.data->>'manufacturer') = lower(${b}) AND ${INSTALL_DATE("e")} IS NOT NULL AND ${INSTALL_DATE("e")} <= ${q.today()} - 90 AND ${noWarrantyReg(q)}`;
    });
  }
  for (const city of CITIES.slice(0, 4)) {
    CQ("number", `How many units in ${city} installed more than 90 days ago have no warranty registration on file?`, "office", (q) => {
      const c = q.p(city);
      return `SELECT count(*) AS n FROM ${EQUIP} AND lower(${GEO.city(`COALESCE(e.data->>'service_address', (SELECT c0.data->>'service_address' FROM entities c0 WHERE c0.id = e.customer_id))`)}) = lower(${c}) AND ${INSTALL_DATE("e")} IS NOT NULL AND ${INSTALL_DATE("e")} <= ${q.today()} - 90 AND ${noWarrantyReg(q)}`;
    });
  }

  /* ---- invoices that don't match what was quoted for the same job */
  const INV_QUOTE_DIFF = `SELECT c.data->>'customer_name' AS name, sum(f.total) FILTER (WHERE f.doc_kind = 'invoice') AS inv_total, sum(f.total) FILTER (WHERE f.doc_kind = 'estimate') AS quote_total
      FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
      JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer' AND c.merged_into IS NULL
      WHERE f.doc_kind IN ('invoice', 'estimate') AND f.direction = 'receivable' GROUP BY c.id, c.data`;
  const FIN_REQ2 = { sql: `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind IN ('invoice', 'estimate')` };
  CQ("set", "Which customers have an invoice that doesn't match the amount on their quote?", "bookkeeper", () => ({ sql: `SELECT name AS item FROM (${INV_QUOTE_DIFF}) g WHERE inv_total IS NOT NULL AND quote_total IS NOT NULL AND abs(inv_total - quote_total) > 1 ORDER BY 1`, requires: FIN_REQ2 }));
  CQ("number", "How many customers were invoiced a different amount than what they were quoted?", "owner", () => ({ sql: `SELECT count(*) AS n FROM (${INV_QUOTE_DIFF}) g WHERE inv_total IS NOT NULL AND quote_total IS NOT NULL AND abs(inv_total - quote_total) > 1`, requires: FIN_REQ2 }));
  for (const city of CITIES.slice(0, 4)) {
    add("connect", "office", `How many ${city} customers have an invoice that doesn't match their quote?`, (q) => {
      const c = q.p(city);
      return { cmp: "number", sql: `SELECT count(*) AS n FROM (${INV_QUOTE_DIFF}) g, ${CUST} AND c.data->>'customer_name' = g.name AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c}) AND g.inv_total IS NOT NULL AND g.quote_total IS NOT NULL AND abs(g.inv_total - g.quote_total) > 1`, requires: FIN_REQ2 };
    });
  }
  for (const name of NAMES.slice(0, 6)) {
    add("connect", "bookkeeper", `Does ${name}'s invoice match what was quoted for the job?`, (q) => {
      const s = subj(name, q);
      return {
        cmp: "yesno",
        sql: `SELECT (abs(coalesce((SELECT sum(f.total) FROM document_financials f WHERE f.doc_kind = 'invoice' AND f.document_id IN (${s.docs})), 0)
          - coalesce((SELECT sum(f.total) FROM document_financials f WHERE f.doc_kind = 'estimate' AND f.document_id IN (${s.docs})), 0)) <= 1) AS v`,
        requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind IN ('invoice', 'estimate') AND f.document_id IN (${s.docs})` },
        scope: { sql: s.docs },
      };
    });
  }

  /* ---- customers quoted more than 6 months ago with no invoice since (a stalled job) */
  // `idsSql`: a subquery of the candidate customer id(s) - either the whole customers table (c.id, one row per
  // customer already in the outer FROM) or one named subject's own id(s) (subj().cust, for the per-name form below).
  const quotedNotInvoiced = (q, idsSql) => `EXISTS (
      SELECT 1 FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
      WHERE (l.entity_id IN (${idsSql}) OR le.customer_id IN (${idsSql})) AND f.doc_kind = 'estimate' AND f.invoice_date IS NOT NULL AND f.invoice_date <= ${q.today()} - 180
    ) AND NOT EXISTS (
      SELECT 1 FROM document_financials f2 JOIN document_entity_links l2 ON l2.document_id = f2.document_id LEFT JOIN entities le2 ON le2.id = l2.entity_id AND le2.entity_type = 'equipment'
      WHERE (l2.entity_id IN (${idsSql}) OR le2.customer_id IN (${idsSql})) AND f2.doc_kind = 'invoice'
    )`;
  const OWN_ID = "SELECT c.id";
  CQ("set", "Which customers were quoted more than 6 months ago and have not been invoiced since?", "owner", (q) => ({ sql: `SELECT c.data->>'customer_name' AS item FROM ${CUST} AND ${quotedNotInvoiced(q, OWN_ID)} ORDER BY 1`, requires: FIN_REQ2 }));
  CQ("number", "How many customers were quoted more than 6 months ago with no invoice since?", "bookkeeper", (q) => ({ sql: `SELECT count(*) AS n FROM ${CUST} AND ${quotedNotInvoiced(q, OWN_ID)}`, requires: FIN_REQ2 }));
  for (const name of NAMES.slice(0, 6)) {
    add("connect", "office", `Was ${name} quoted a job that was never invoiced?`, (q) => {
      const s = subj(name, q);
      return { cmp: "yesno", sql: `SELECT ${quotedNotInvoiced(q, s.cust)} AS v`, requires: { sql: `SELECT count(*) AS n FROM document_financials f WHERE f.doc_kind IN ('invoice', 'estimate') AND f.document_id IN (${s.docs})` }, scope: { sql: s.docs } };
    });
  }

  /* ---- customers with more than one open invoice at once (a billing pile-up) */
  const MULTI_OPEN = `SELECT c.data->>'customer_name' AS item FROM document_financials f JOIN document_entity_links l ON l.document_id = f.document_id LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
      JOIN entities c ON (c.id = l.entity_id OR c.id = le.customer_id) AND c.entity_type = 'customer' AND c.merged_into IS NULL
      WHERE ${INV} AND ${OPEN} GROUP BY c.id, c.data HAVING count(*) > 1`;
  CQ("set", "Which customers have more than one open invoice at once?", "bookkeeper", () => ({ sql: `SELECT item FROM (${MULTI_OPEN}) z ORDER BY 1`, requires: FIN_REQ("invoice") }));
  CQ("number", "How many customers have more than one open invoice right now?", "owner", () => ({ sql: `SELECT count(*) AS n FROM (${MULTI_OPEN}) z`, requires: FIN_REQ("invoice") }));
  for (const city of CITIES.slice(0, 4)) {
    add("connect", "office", `How many ${city} customers have more than one open invoice at once?`, (q) => {
      const c = q.p(city);
      return { cmp: "number", sql: `SELECT count(*) AS n FROM (${MULTI_OPEN}) z, ${CUST} AND c.data->>'customer_name' = z.item AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c})`, requires: FIN_REQ("invoice") };
    });
  }

  /* ---- the same part replaced more than once on the same unit */
  const PARTS = ["capacitor", "contactor", "motor", "filter", "coil", "thermostat"];
  PARTS.forEach((part, i) => {
    CQ("set", `Which customers have had the ${part} replaced more than once?`, "tech", (q) => {
      const pat = q.p(REPLACE_RE(part));
      return `SELECT c.data->>'customer_name' AS item FROM ${CUST} AND (
          SELECT count(DISTINCT p.document_id) FROM document_pages p JOIN document_entity_links l ON l.document_id = p.document_id LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
          WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND p.text ~* ${pat}
        ) > 1 ORDER BY 1`;
    });
    CQ("number", `How many units have had the ${part} replaced more than once?`, ["owner", "tech"][i % 2], (q) => {
      const pat = q.p(REPLACE_RE(part));
      return `SELECT count(*) AS n FROM (
          SELECT le.id FROM document_pages p JOIN document_entity_links l ON l.document_id = p.document_id JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment'
          WHERE p.text ~* ${pat} GROUP BY le.id HAVING count(DISTINCT p.document_id) > 1
        ) z`;
    });
  });
  for (const name of NAMES.slice(0, 8)) {
    add("connect", "office", `Has ${name} had any part replaced more than once on the same unit?`, (q) => {
      const s = subj(name, q); const pat = q.p("(replac\\w*[^.]{0,60}(capacitor|contactor|motor|filter|coil|thermostat)|(capacitor|contactor|motor|filter|coil|thermostat)[^.]{0,40}replac)");
      return { cmp: "yesno", sql: `SELECT EXISTS (
          SELECT 1 FROM document_pages p JOIN document_entity_links l ON l.document_id = p.document_id
          WHERE l.entity_id IN (${s.equip}) AND p.text ~* ${pat} GROUP BY l.entity_id HAVING count(DISTINCT p.document_id) > 1
        ) AS v`, requires: { sql: s.req }, scope: { sql: s.docs } };
    });
  }

  /* ---- addresses that disagree across documents */
  const ADDR_MISMATCH_FROM = "entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_address'";
  const ADDR_MISMATCH_WHERE = "c.entity_type = 'customer' AND c.merged_into IS NULL AND coalesce(y.value, '') <> '' AND lower(btrim(y.value)) <> lower(btrim(coalesce(c.data->>'service_address', '')))";
  CQ("set", "Which customers have a different address on one of their documents than what's on file?", "office", () => `SELECT DISTINCT c.data->>'customer_name' AS item FROM ${ADDR_MISMATCH_FROM} WHERE ${ADDR_MISMATCH_WHERE} ORDER BY 1`);
  CQ("number", "How many customers have a document with an address that doesn't match what's on file?", "office", () => `SELECT count(DISTINCT c.id) AS n FROM ${ADDR_MISMATCH_FROM} WHERE ${ADDR_MISMATCH_WHERE}`);
  for (const city of CITIES.slice(0, 4)) {
    add("connect", "office", `How many ${city} customers have a document address that doesn't match their record?`, (q) => {
      const c = q.p(city);
      return { cmp: "number", sql: `SELECT count(DISTINCT c.id) AS n FROM ${ADDR_MISMATCH_FROM} WHERE ${ADDR_MISMATCH_WHERE} AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c})` };
    });
  }
  for (const name of NAMES.slice(0, 4)) {
    add("connect", "office", `What is the correct current address for ${name}, and why?`, (q) => {
      const s = subj(name, q);
      return {
        cmp: "rubric",
        rubric: "States one current address for this customer, matching the most recently dated document/record in the reference, and explains why if the reference shows more than one address on file (which is newest). Must not invent an address not in the reference.",
        sql: `SELECT addr || ' (as of ' || coalesce(dt::text, 'unknown date') || ')' AS ref FROM (
            SELECT c.data->>'service_address' AS addr, c.created_at::date AS dt FROM entities c WHERE c.id IN (${s.cust})
            UNION ALL
            SELECT y.value, d.created_at::date FROM extractions y JOIN documents d ON d.id = y.document_id JOIN document_entity_links l ON l.document_id = d.id WHERE l.entity_id IN (${s.cust}) AND y.field_key = 'service_address' AND coalesce(y.value, '') <> ''
          ) z ORDER BY dt DESC NULLS LAST LIMIT 8`,
        requires: { sql: s.req },
        scope: { sql: s.docs },
      };
    }, { citeWhat: "the document that carries the most recent address" });
  }

  /* ---- equipment serials that appear under more than one customer (a data-entry or a real duplicate) */
  CQ("yesno", "Are there any equipment serial numbers that appear under more than one customer?", "tech", () => `SELECT EXISTS (SELECT 1 FROM ${EQUIP} AND coalesce(e.data->>'serial_number', '') <> ''
      AND (SELECT count(DISTINCT e2.customer_id) FROM entities e2 WHERE e2.entity_type = 'equipment' AND e2.merged_into IS NULL AND upper(e2.data->>'serial_number') = upper(e.data->>'serial_number')) > 1) AS v`);
  CQ("set", "Which serial numbers appear under more than one customer?", "tech", () => `SELECT DISTINCT upper(e.data->>'serial_number') AS item FROM ${EQUIP} AND coalesce(e.data->>'serial_number', '') <> ''
      AND (SELECT count(DISTINCT e2.customer_id) FROM entities e2 WHERE e2.entity_type = 'equipment' AND e2.merged_into IS NULL AND upper(e2.data->>'serial_number') = upper(e.data->>'serial_number')) > 1 ORDER BY 1`);
  CQ("number", "How many equipment serial numbers are shared by more than one customer?", "owner", () => `SELECT count(*) AS n FROM (SELECT upper(e.data->>'serial_number') AS sn FROM ${EQUIP} AND coalesce(e.data->>'serial_number', '') <> '' GROUP BY 1 HAVING count(DISTINCT e.customer_id) > 1) z`);

  /* ---- maintenance agreements with zero visits behind them */
  const AGR_NO_VISIT = (q) => `${custDoc(agr(q))} AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id LEFT JOIN entities le ON le.id = l.entity_id WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND ${DOCTYPE("d.document_type")} = ANY(${vt(q)}))`;
  CQ("set", "Which customers have a maintenance agreement but have never had a service visit?", "owner", (q) => `SELECT c.data->>'customer_name' AS item FROM ${CUST} AND ${AGR_NO_VISIT(q)} ORDER BY 1`);
  CQ("number", "How many maintenance agreements have zero service visits behind them?", "bookkeeper", (q) => `SELECT count(*) AS n FROM ${CUST} AND ${AGR_NO_VISIT(q)}`);
  for (const city of CITIES.slice(0, 4)) {
    CQ("number", `How many customers in ${city} have a maintenance agreement but no service visits on file?`, "office", (q) => {
      const c = q.p(city);
      return `SELECT count(*) AS n FROM ${CUST} AND lower(${GEO.city("(c.data->>'service_address')")}) = lower(${c}) AND ${AGR_NO_VISIT(q)}`;
    });
  }
  for (const brand of BRANDS.slice(0, 4)) {
    CQ("number", `How many maintenance agreements are there for ${brand} customers with zero service visits?`, "office", (q) => {
      const b = q.p(brand);
      return `SELECT count(*) AS n FROM ${CUST} AND ${custUnit(` AND lower(e.data->>'manufacturer') = lower(${b})`)} AND ${AGR_NO_VISIT(q)}`;
    });
  }

  /* ---- narratives: what happened, in order, across the year's documents (must not invent a visit or date) */
  for (const name of NAMES) {
    const persona = ["office", "tech", "owner", "bookkeeper"][NAMES.indexOf(name) % 4];
    add("connect", persona, `Walk me through what happened at ${name}'s property this year, in order.`, (q) => {
      const s = subj(name, q); const w = windowFor("this year", q);
      return {
        cmp: "rubric",
        rubric: "Narrates the customer's service visits and key documents this year in date order (each with its own date), consistent with the reference; says nothing happened this year if the reference is empty. Must not invent a visit, date or finding not in the reference.",
        sql: `SELECT ${ISO("y.value")}::text || ' | ' || ${DOCTYPE("d.document_type")} || ' | ' || left(regexp_replace(coalesce((SELECT string_agg(p.text, ' ') FROM document_pages p WHERE p.document_id = d.id), ''), '[[:space:]]+', ' ', 'g'), 160) AS ref
          FROM extractions y JOIN documents d ON d.id = y.document_id WHERE y.field_key = 'service_date' AND y.document_id IN (${s.docs}) AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end} ORDER BY ${ISO("y.value")} ASC LIMIT 10`,
        requires: { sql: s.req },
        scope: { sql: s.docs },
      };
    }, { citeWhat: "each visit or document it narrates" });
  }

  /* ---- conflicting facts across documents: which is right, and why */
  for (const name of NAMES) {
    add("connect", ["bookkeeper", "office"][NAMES.indexOf(name) % 2], `Do any of ${name}'s documents disagree with our records, and if so which is right?`, (q) => {
      const s = subj(name, q);
      return {
        cmp: "rubric",
        rubric: "If the reference shows a document value (address, phone or email) that differs from what is on the customer record, says so and states which one should be trusted (normally the most recently dated one) with a reason; if the reference shows no disagreement, says the records agree. Must not invent a conflict or a value not in the reference.",
        sql: `SELECT field || ': record says ' || coalesce(onfile, '(nothing on file)') || ' -- document ' || docname || ' (' || coalesce(docdate::text, 'undated') || ') says ' || docval AS ref FROM (
            SELECT 'phone' AS field, c.data->>'phone' AS onfile, y.value AS docval, d.original_filename AS docname, d.created_at::date AS docdate
              FROM entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'phone' JOIN documents d ON d.id = y.document_id
              WHERE c.id IN (${s.cust}) AND coalesce(y.value, '') <> '' AND regexp_replace(y.value, '[^0-9]', '', 'g') <> regexp_replace(coalesce(c.data->>'phone', ''), '[^0-9]', '', 'g')
            UNION ALL
            SELECT 'email', c.data->>'email', y.value, d.original_filename, d.created_at::date
              FROM entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'email' JOIN documents d ON d.id = y.document_id
              WHERE c.id IN (${s.cust}) AND coalesce(y.value, '') <> '' AND lower(btrim(y.value)) <> lower(btrim(coalesce(c.data->>'email', '')))
            UNION ALL
            SELECT 'address', c.data->>'service_address', y.value, d.original_filename, d.created_at::date
              FROM entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_address' JOIN documents d ON d.id = y.document_id
              WHERE c.id IN (${s.cust}) AND coalesce(y.value, '') <> '' AND lower(btrim(y.value)) <> lower(btrim(coalesce(c.data->>'service_address', '')))
          ) z ORDER BY docdate DESC LIMIT 6`,
        requires: { sql: s.req },
        scope: { sql: s.docs },
      };
    }, { citeWhat: "the document whose value differs from the record" });
  }

  return out;
}
