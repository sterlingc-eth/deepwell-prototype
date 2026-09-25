/**
 * Donovan research agent (v2) — compute(): arithmetic and date math the model may need while
 * reconciling numbers across documents (a total across N invoices, "how many months until the
 * warranty expires", "how many days since the last visit"). The model is told (loopV2.js's system
 * prompt) that every number in its answer must come from a tool, INCLUDING arithmetic — a model
 * doing its own addition in prose is exactly the "SAME question, different total on two runs" bug
 * temperature 0 alone does not fully close (see ask.js's own comment on that).
 *
 * SECURITY: this is a hand-written recursive-descent parser/evaluator over a tiny closed grammar —
 * numbers, + - * / ( ), and a fixed set of date functions. It NEVER calls eval()/new Function() on
 * the model's input, so there is no code-injection surface no matter what string the model sends.
 *
 * Grammar:
 *   expr    := term (('+'|'-') term)*
 *   term    := unary (('*'|'/') unary)*
 *   unary   := '-' unary | atom
 *   atom    := NUMBER | '(' expr ')' | IDENT '(' args? ')'
 *   args    := arg (',' arg)*
 *   arg     := expr | "'YYYY-MM-DD'" (a quoted date literal, only inside a function call)
 *
 * Date functions (all pure, UTC, no locale/timezone ambiguity):
 *   today()                    -> today's date (the `today` the agent was given), as 'YYYY-MM-DD'
 *   daysBetween(a, b)          -> b - a, in whole days (can be negative)
 *   monthsBetween(a, b)        -> b - a, in whole months (calendar months, ignoring day-of-month)
 *   yearsBetween(a, b)         -> b - a, in whole years
 *   addDays(a, n) / addMonths(a, n) / addYears(a, n) -> 'YYYY-MM-DD'
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ComputeError extends Error {}

function parseDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) throw new ComputeError(`not a YYYY-MM-DD date: ${JSON.stringify(s)}`);
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new ComputeError(`not a real date: ${s}`);
  return dt;
}
const fmtDate = (dt) => dt.toISOString().slice(0, 10);
const asNum = (v, ctx) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new ComputeError(`${ctx} needs a number`); return v; };
const asDate = (v, ctx) => { if (typeof v !== "string") throw new ComputeError(`${ctx} needs a date`); return parseDate(v); };

const FUNCTIONS = {
  today: (args, today) => { if (args.length) throw new ComputeError("today() takes no arguments"); return today; },
  daysBetween: (args) => { const [a, b] = args; return Math.round((asDate(b, "daysBetween") - asDate(a, "daysBetween")) / 86_400_000); },
  monthsBetween: (args) => {
    const a = asDate(args[0], "monthsBetween"), b = asDate(args[1], "monthsBetween");
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
  },
  yearsBetween: (args) => Math.trunc(FUNCTIONS.monthsBetween(args) / 12),
  addDays: (args) => { const [a, n] = args; const d = asDate(a, "addDays"); d.setUTCDate(d.getUTCDate() + Math.trunc(asNum(n, "addDays"))); return fmtDate(d); },
  addMonths: (args) => { const [a, n] = args; const d = asDate(a, "addMonths"); d.setUTCMonth(d.getUTCMonth() + Math.trunc(asNum(n, "addMonths"))); return fmtDate(d); },
  addYears: (args) => { const [a, n] = args; const d = asDate(a, "addYears"); d.setUTCFullYear(d.getUTCFullYear() + Math.trunc(asNum(n, "addYears"))); return fmtDate(d); },
};
export const COMPUTE_FUNCTION_NAMES = Object.keys(FUNCTIONS);

/** Tokenizer: numbers, identifiers, quoted date literals, operators, punctuation. */
function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|'([^']*)'|"([^"]*)"|([+\-*/(),]))/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m || m[0].length === 0) throw new ComputeError(`could not parse at position ${i}: ${JSON.stringify(src.slice(i, i + 12))}`);
    if (m[1] !== undefined) toks.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: "ident", v: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) toks.push({ t: "date", v: m[3] ?? m[4] });
    else toks.push({ t: "op", v: m[5] });
    i = re.lastIndex;
  }
  toks.push({ t: "eof" });
  return toks;
}

/** Parses and evaluates in one pass (the grammar is small enough that a second AST layer buys nothing). */
function evaluate(toks, today) {
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (t, v) => {
    const tok = toks[pos];
    if (tok.t !== t || (v !== undefined && tok.v !== v)) throw new ComputeError(`expected ${v ?? t} but got ${tok.v ?? tok.t}`);
    pos++;
    return tok;
  };

  function parseArg() {
    if (peek().t === "date") { const d = eat("date").v; return d; }
    return parseExpr();
  }
  function parseAtom() {
    const tok = peek();
    if (tok.t === "num") { pos++; return tok.v; }
    if (tok.t === "date") { pos++; return tok.v; }
    if (tok.t === "op" && tok.v === "(") { pos++; const v = parseExpr(); eat("op", ")"); return v; }
    if (tok.t === "ident") {
      pos++;
      eat("op", "(");
      const args = [];
      if (!(peek().t === "op" && peek().v === ")")) {
        args.push(parseArg());
        while (peek().t === "op" && peek().v === ",") { pos++; args.push(parseArg()); }
      }
      eat("op", ")");
      const fn = FUNCTIONS[tok.v];
      if (!fn) throw new ComputeError(`unknown function: ${tok.v} (available: ${COMPUTE_FUNCTION_NAMES.join(", ")})`);
      return fn(args, today);
    }
    throw new ComputeError(`unexpected token: ${tok.v ?? tok.t}`);
  }
  function parseUnary() {
    if (peek().t === "op" && peek().v === "-") { pos++; return -asNum(parseUnary(), "unary -"); }
    return parseAtom();
  }
  // v may be a plain value (a number OR a date string, e.g. a bare `today()` or `addMonths(...)` call)
  // until an operator actually forces arithmetic — asNum() is only applied once a `* / + -` is seen, so
  // a lone date-returning function call passes through untouched instead of failing on its own result.
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (peek().t === "op" && peek().v === "*") { pos++; v = asNum(v, "*") * asNum(parseUnary(), "*"); }
      else if (peek().t === "op" && peek().v === "/") { pos++; const d = asNum(parseUnary(), "/"); if (d === 0) throw new ComputeError("division by zero"); v = asNum(v, "/") / d; }
      else return v;
    }
  }
  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (peek().t === "op" && peek().v === "+") { pos++; v = asNum(v, "+") + asNum(parseTerm(), "+"); }
      else if (peek().t === "op" && peek().v === "-") { pos++; v = asNum(v, "-") - asNum(parseTerm(), "-"); }
      else return v;
    }
  }
  const result = parseExpr();
  eat("eof");
  return result;
}

/**
 * @param {string} expression
 * @param {string} today  YYYY-MM-DD, what today() resolves to
 * @returns {{ok: true, value: number|string} | {ok: false, error: string}}
 */
export function computeExpression(expression, today) {
  const src = String(expression ?? "").trim().slice(0, 300);
  if (!src) return { ok: false, error: "expression is required" };
  try {
    const toks = tokenize(src);
    const value = evaluate(toks, today);
    if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, error: "result is not a finite number" };
    return { ok: true, value: typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value };
  } catch (err) {
    return { ok: false, error: err instanceof ComputeError ? err.message : String(err?.message ?? err).slice(0, 200) };
  }
}
