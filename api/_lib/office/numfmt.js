/**
 * Excel number formats -> the text a person reads. Pure. Used by xlsx.js (CSV needs none: its cells are already text).
 *   - dates: ISO (YYYY-MM-DD, with " HH:MM[:SS]" when the format shows a time; time-only formats give HH:MM[:SS]); the
 *     1900 system (including Excel's fake 29 Feb 1900, serial 60) and the 1904 system;
 *   - percent, thousands separators, fixed decimals, scientific, currency symbol ($ € £ ¥ or [$X-locale]), accounting
 *     and parentheses-for-negative formats;
 *   - General: full precision (up to 15 significant digits, the way Excel shows it; float noise such as
 *     0.30000000000000004 reads 0.3; a genuine 16-17 digit value such as 3.141592653589793 is kept whole).
 * Deliberate difference from Excel: a negative number always shows its sign ("-50.00" or "(50.00)"), even when a custom
 * format's negative section omits one, because an unsigned negative would be misread by a person and by a search.
 * Zero always shows as a number (not the accounting dash). Fractions ("# ?/?") show as decimals. Nothing is evaluated.
 */

const BUILTIN = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "yyyy-mm-dd", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm", 27: "yyyy-mm-dd", 28: "yyyy-mm-dd", 29: "yyyy-mm-dd", 30: "yyyy-mm-dd", 31: "yyyy-mm-dd",
  32: "h:mm", 33: "h:mm:ss", 34: "h:mm", 35: "h:mm:ss", 36: "yyyy-mm-dd",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
  50: "yyyy-mm-dd", 51: "yyyy-mm-dd", 52: "yyyy-mm-dd", 53: "yyyy-mm-dd", 54: "yyyy-mm-dd", 55: "yyyy-mm-dd", 56: "yyyy-mm-dd", 57: "yyyy-mm-dd", 58: "yyyy-mm-dd",
};

/** Split a format into its ';' sections (outside quotes). */
function sections(code) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') q = !q;
    if (ch === "\\" && !q) { cur += ch + (code[i + 1] ?? ""); i++; continue; }
    if (ch === ";" && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Tokenize one section. */
function analyse(sec) {
  const a = { pre: "", post: "", pattern: "", date: false, time: false, elapsed: false, percent: false, sci: false, paren: false, text: false, currency: "" };
  let seenNum = false;
  let i = 0;
  const lit = (s) => { if (seenNum) a.post += s; else a.pre += s; };
  while (i < sec.length) {
    const ch = sec[i];
    if (ch === '"') {
      const e = sec.indexOf('"', i + 1);
      const s = sec.slice(i + 1, e < 0 ? sec.length : e);
      lit(s);
      i = e < 0 ? sec.length : e + 1;
    } else if (ch === "\\") { lit(sec[i + 1] ?? ""); i += 2; }
    else if (ch === "_" || ch === "*") { i += 2; }
    else if (ch === "[") {
      const e = sec.indexOf("]", i);
      const inner = sec.slice(i + 1, e < 0 ? sec.length : e);
      if (inner[0] === "$") {
        const cur = inner.slice(1).split("-")[0];
        if (cur) { a.currency = cur; lit(cur); }
      } else if (/^(h+|m+|s+)$/i.test(inner)) { a.elapsed = true; a.time = true; a.lastTok = "h"; }
      i = e < 0 ? sec.length : e + 1;
    } else if ("0#?".includes(ch)) { seenNum = true; a.pattern += ch; i++; }
    else if (ch === "." || ch === ",") {
      if (seenNum || /[0#?]/.test(sec[i + 1] ?? "")) { seenNum = true; a.pattern += ch; } else lit(ch);
      i++;
    } else if (ch === "%") { a.percent = true; lit("%"); i++; }
    else if ((ch === "E" || ch === "e") && (sec[i + 1] === "+" || sec[i + 1] === "-") && seenNum) { a.sci = true; i += 2; while (sec[i] === "0") i++; }
    else if (ch === "@") { a.text = true; i++; }
    else if (ch === "m" || ch === "M") {
      // m is a MINUTE right after an hour or right before seconds ("h:mm", "mm:ss"), otherwise a month.
      let j = i;
      while (sec[j] === "m" || sec[j] === "M") j++;
      let k = j;
      while (sec[k] === ":" || sec[k] === " ") k++;
      if (a.lastTok === "h" || /^[sS]/.test(sec.slice(k))) a.time = true; else a.date = true;
      i = j;
    }
    else if (/[yYdD]/.test(ch)) { a.date = true; a.lastTok = "d"; i++; }
    else if (/[hH]/.test(ch)) { a.time = true; a.lastTok = "h"; i++; }
    else if (/[sS]/.test(ch)) { a.time = true; a.lastTok = "s"; i++; }
    else if ((ch === "A" || ch === "a") && /^(AM\/PM|A\/P)/i.test(sec.slice(i, i + 5))) { a.time = true; i += /^AM\/PM/i.test(sec.slice(i, i + 5)) ? 5 : 3; }
    else if (/[G]/.test(ch) && sec.slice(i, i + 7).toLowerCase() === "general") { a.general = true; i += 7; }
    else {
      if (ch === "(" ) a.paren = true;
      if ("$€£¥".includes(ch)) a.currency = ch;
      if (ch !== " " || seenNum || a.pre) lit(ch);
      i++;
    }
  }
  return a;
}

const formatCache = new Map();
/** Parse (and cache) a format code into {kind, sections:[analysis]}. kind: general|text|date|time|datetime|number */
export function parseFormat(code) {
  // A real format code is a few dozen characters. A longer one is hostile or garbage: read as General (and never cached, so a
  // stream of such workbooks cannot pin memory in a warm worker).
  if (typeof code !== "string" || code.length > 256) return GENERAL_FMT;
  let f = formatCache.get(code);
  if (f) return f;
  const secs = sections(code).slice(0, 4).map(analyse);
  const s0 = secs[0];
  let kind = "number";
  if (s0.general || (!s0.pattern && !s0.date && !s0.time && !s0.text)) kind = s0.date || s0.time ? "date" : "general";
  if (s0.text && !s0.pattern && !s0.date && !s0.time) kind = "text";
  if (s0.date && s0.time) kind = "datetime";
  else if (s0.date) kind = "date";
  else if (s0.time && !s0.pattern) kind = "time";
  if (code.trim() === "" ) kind = "general";
  f = { kind, secs, elapsed: s0.elapsed, hasSeconds: /s/i.test(code.replace(/"[^"]*"/g, "")) };
  if (formatCache.size >= 500) formatCache.delete(formatCache.keys().next().value); // small FIFO bound
  formatCache.set(code, f);
  return f;
}
const GENERAL_FMT = { kind: "general", secs: [], elapsed: false, hasSeconds: false };

export function formatForId(id, customCodes) {
  const custom = customCodes?.get(id);
  const code = custom ?? BUILTIN[id] ?? "General";
  return parseFormat(code);
}

/** General: full precision, no float noise. */
export function generalNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return BigInt(n).toString();
  const s = String(n);
  const digits = s.replace(/^-/, "").replace(/e.*$/i, "").replace(".", "").replace(/^0+/, "");
  if (digits.length > 15) {
    const r = Number(n.toPrecision(15));
    const rd = String(r).replace(/^-/, "").replace(/e.*$/i, "").replace(".", "").replace(/^0+/, "");
    if (rd.length <= 13) return fixExp(String(r));
  }
  return fixExp(s);
}
function fixExp(s) {
  if (!/e/i.test(s)) return s;
  const n = Number(s);
  if (Math.abs(n) < 1e21 && Math.abs(n) >= 1e-9) return n.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function roundTo(v, d) {
  const s = String(v);
  if (s.includes("e")) return v.toFixed(d);
  const r = Number(Math.round(Number(s + "e" + d)) + "e-" + d);
  return Number.isFinite(r) ? r.toFixed(d) : v.toFixed(d);
}

function formatNumber(v, a) {
  const neg = v < 0;
  let x = Math.abs(v);
  if (a.percent) x *= 100;
  const pat = a.pattern;
  const dot = pat.indexOf(".");
  const intPart = dot < 0 ? pat : pat.slice(0, dot);
  const decPart = dot < 0 ? "" : pat.slice(dot + 1).replace(/,/g, "");
  const trailingCommas = /,+$/.test(intPart) ? intPart.match(/,+$/)[0].length : 0;
  if (trailingCommas) x /= 1000 ** trailingCommas;
  const thousands = /[0#?],[0#?]/.test(intPart);
  const maxDec = Math.min(decPart.length, 30);
  const minDec = (decPart.match(/0/g) ?? []).length;
  let body;
  if (a.sci) {
    const e = x === 0 ? 0 : Math.floor(Math.log10(x));
    const m = x / 10 ** e;
    body = roundTo(m, maxDec) + "E" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
  } else {
    body = roundTo(x, maxDec);
    if (maxDec > minDec && body.includes(".")) {
      let [ip, fp] = body.split(".");
      while (fp.length > minDec && fp.endsWith("0")) fp = fp.slice(0, -1);
      body = fp ? ip + "." + fp : ip;
    }
    let [ip, fp] = body.split(".");
    const minInt = (intPart.match(/0/g) ?? []).length;
    if (ip.length < minInt) ip = ip.padStart(minInt, "0");
    if (ip === "0" && minInt === 0 && fp) ip = "0";
    if (thousands) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    body = fp !== undefined ? ip + "." + fp : ip;
  }
  const isZero = Number(body.replace(/[^0-9.]/g, "")) === 0;
  let out = a.pre + body + a.post;
  if (neg && !isZero) out = a.paren ? out : (/^[^0-9]*-/.test(a.pre) ? out : "-" + out);
  return out.trim();
}

const pad2 = (n) => String(n).padStart(2, "0");

/** serial -> {y,m,d,hh,mm,ss} or null when outside Excel's date range. */
export function serialToParts(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0) return null;
  let ms = Math.round(serial * 86400000);
  let days = Math.floor(ms / 86400000);
  const rem = ms - days * 86400000;
  const hh = Math.floor(rem / 3600000), mm = Math.floor((rem % 3600000) / 60000), ss = Math.floor((rem % 60000) / 1000);
  if (date1904) {
    if (days > 2957003) return null;
    const d = new Date(Date.UTC(1904, 0, 1) + days * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh, mm, ss };
  }
  if (days > 2958465) return null;
  if (days === 0) return { y: 1900, m: 1, d: 0, hh, mm, ss };
  if (days === 60) return { y: 1900, m: 2, d: 29, hh, mm, ss }; // Excel's leap-year bug: 1900 was not a leap year
  const d = new Date(Date.UTC(1899, 11, 30) + (days < 60 ? days + 1 : days) * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh, mm, ss };
}

/**
 * @returns {{text:string, kind:'num'|'date'|'text'}}
 */
export function formatNumeric(value, fmt, date1904) {
  if (fmt.kind === "date" || fmt.kind === "datetime" || fmt.kind === "time") {
    if (fmt.elapsed) {
      const totalSec = Math.round(Math.abs(value) * 86400);
      const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
      return { text: `${value < 0 ? "-" : ""}${h}:${pad2(m)}${fmt.hasSeconds ? ":" + pad2(s) : ""}`, kind: "date" };
    }
    const p = serialToParts(value, date1904);
    if (!p) return { text: generalNumber(value), kind: "num" };
    const dateStr = `${String(p.y).padStart(4, "0")}-${pad2(p.m)}-${pad2(p.d)}`;
    const timeStr = `${pad2(p.hh)}:${pad2(p.mm)}${fmt.hasSeconds || p.ss ? ":" + pad2(p.ss) : ""}`;
    if (fmt.kind === "date") return { text: dateStr, kind: "date" };
    if (fmt.kind === "time") return { text: timeStr, kind: "date" };
    return { text: `${dateStr} ${timeStr}`, kind: "date" };
  }
  if (fmt.kind === "general" || fmt.kind === "text") return { text: generalNumber(value), kind: "num" };
  const idx = value < 0 && fmt.secs.length > 1 ? 1 : 0;
  const a = fmt.secs[idx];
  if (!a || !a.pattern) return { text: generalNumber(value), kind: "num" };
  try {
    return { text: formatNumber(value, a), kind: "num" };
  } catch {
    // e.g. a format asking for 101+ decimals: that one cell reads as General, the workbook is still read
    return { text: generalNumber(value), kind: "num" };
  }
}
