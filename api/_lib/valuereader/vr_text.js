// valuereader2: generic fix flags (all default ON; set CFG.x=false to measure the before state).
export const CFG = { labStop: true, grpAdmin: true, nameLab: true, sheetPA: true, ing: true, capVal: true, qdom: true, echoVal: true, ocrVer: true, ocrGuard: true, paraQ: true, defNB: true, rateKeep: true, rowRecon: true, capDoc: true, capBlank: true, proseDown: true, howQ: true, ingClause: true, normQ: true, nameSnap: true, headKeep: false, ingMulti: true, ingCap: true, ingProse: true, fx: true, kindSyn: true, prose: true, numFix: true, nameExact: true, dateDef: true, rowPref: true, bareAmb: true, sup: true, ops: true, qual: true, kindLab: true, near8: true, recon: true, tbl: true, cells: true, sel: true, hop: true, cmp: true, agg: true, cur: true, ocr: true, inj: true, gsyn: true, line: true, rowGuard: true, bareMulti: true, kvMulti: true, oddShift: true, noNearCell: true, leftCol: true, stackMulti: true, selName: true, exactTie: true, rightStack: true, bareOne: true, ptrHop: true, aggAll: true, qualDoc: false, labelVal: true, phoneBal: true, id8: true, bareDef: false, unitNoun: true };
// Generic text helpers: typed-entity regexes, normalisation, date parsing. No industry or vendor vocabulary.
export const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
export const alnum = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const STOP = new Set("what whats is the a an of on for to in at by with and or was were did does do who whom which when where how much many this that it its me my our us we you your please tell show give find from are be been has have had as per any all work works hold holds held live lives make made take takes go goes come comes know there their his her they them these those i s no not file stored listed document documents".split(" "));
export const stem = (w) => { w = w.toLowerCase(); if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y"; if (w.length > 4 && /(ing|ed|es)$/.test(w)) return w.replace(/(ing|ed|es)$/, ""); if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); return w; };
export const words = (s) => norm(s).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);
export const ID_RE = /\b[A-Za-z]{1,8}(?:[-_#][A-Za-z0-9]+)*[-_#]?\d[A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*\b/g;
export const MONEY_RE_BASE = /(?<![\w.])\$\s?\d[\d,]*(?:\.\d{1,2})?(?![\d])|(?<![\w.$])\d{1,3}(?:,\d{3})+(?:\.\d{2})?(?![\d])|(?<![\w.$,/-])\d+\.\d{2}(?![\d/.-])/g;
const CURW = "(?:USD|CAD|EUR|GBP|CA\\$|US\\$|[$\u20ac\u00a3])";
export const MONEY_RE0 = new RegExp(`(?<![\\w.])${CURW}\\s?\\d[\\d.,]*\\d(?!\\d)(?:\\s?(?:USD|CAD|EUR|GBP)\\b)?|(?<![\\w.$\u20ac\u00a3,/-])\\d[\\d.,]*\\d\\s?(?:USD|CAD|EUR|GBP)\\b|` + MONEY_RE_BASE.source, "g");
export const MONEY_FULL = new RegExp(`^(?:${CURW}\\s?\\d[\\d.,]*\\d|\\d[\\d.,]*\\d\\s?(?:USD|CAD|EUR|GBP))$`);
const MON = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const FXM = "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|janeiro|fevereiro|março|abril|maio|junho|julho|setembro|outubro|dezembro|januari|februari|maart|mei|juni|juli|augustus|oktober|maj|augusti|mars|enero|febrero|mayo|junio|julio|septiembre|octubre|noviembre|diciembre|jänner|januar|februar|märz|dezember|janvier|février|avril|juin|juillet|août|septembre|octobre|novembre|décembre";
export const FX_DATE_RE = new RegExp(`\\b\\d{1,2}(?:\\.|\\u00ba|\\u00b0)? (?:de )?(?:${FXM})\\.?,? (?:de )?\\d{4}\\b`, "gi");
const FX_IDX = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12, janeiro: 1, fevereiro: 2, "março": 3, abril: 4, maio: 5, junho: 6, julho: 7, setembro: 9, outubro: 10, dezembro: 12, januari: 1, februari: 2, maart: 3, mei: 5, juni: 6, juli: 7, augustus: 8, oktober: 10, maj: 5, augusti: 8, mars: 3, enero: 1, febrero: 2, mayo: 5, junio: 6, julio: 7, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12, jänner: 1, januar: 1, februar: 2, "märz": 3, dezember: 12, janvier: 1, "février": 2, avril2: 4, juin: 6, juillet: 7, "août": 8, septembre2: 9, octobre: 10, novembre2: 11, "décembre": 12 };
export function parseFxDate(s) {
  const m = String(s).trim().toLowerCase().match(/^(\d{1,2})(?:\.|º|°)? (?:de )?([a-zà-ÿ]+)\.?,? (?:de )?(\d{4})$/); if (!m) return null; const mo = FX_IDX[m[2]]; if (!mo) return null; const d = +m[1], y = +m[3];
  if (d < 1 || d > 31 || y < 1900 || y > 2100) return null; const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1) return null; return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// eu / br / se money spellings the base regex misses ("1.234,56 €", "R$ 1.234,56", "1 234,56 kr")
export const FX_MONEY_RE = /(?<![\w.,])(?:R\$\s?|€\s?)\d{1,3}(?:[.  ]\d{3})*,\d{2}(?![\d,])|(?<![\w.,])\d{1,3}(?:[.  ]\d{3})*,\d{2}\s?(?:€|kr|SEK|NOK|DKK|CHF|R\$)(?![\w])/g;
export const isFxMoney = (v) => { FX_MONEY_RE.lastIndex = 0; const m = FX_MONEY_RE.exec(String(v).trim()); return !!m && m[0].length === String(v).trim().length; };
export function fxMoneyNum(v) { const t = String(v).replace(/[^\d,.  ]/g, "").replace(/[  ]/g, "").replace(/\./g, "").replace(",", "."); const n = parseFloat(t); return Number.isFinite(n) ? n : null; }

export const MONEY_RE = new RegExp(MONEY_RE0.source + "|" + FX_MONEY_RE.source, "g");
export const DATE_RE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b(?:${MON})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b|\\b\\d{1,2} (?:${MON})\\.?,? \\d{4}\\b|\\b\\d{1,2}-(?:${MON})\\.?-\\d{4}\\b|${FX_DATE_RE.source}`, "gi");
export const PHONE_RE = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
export const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export function parseDate(s) {
  s = String(s).trim().replace(/(\d)(st|nd|rd|th)\b/i, "$1"); let y, m, d, a;
  if (CFG.fx) { const f = parseFxDate(s); if (f) return f; }
  if ((a = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +a[1]; m = +a[2]; d = +a[3]; }
  else if ((a = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { m = +a[1]; d = +a[2]; y = +a[3]; if (y < 100) y += 2000; if (m > 12 && d <= 12) [m, d] = [d, m]; }
  else if ((a = s.match(/^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/))) { m = MONTHS.findIndex((x) => x.startsWith(a[1].toLowerCase().slice(0, 3))) + 1; d = +a[2]; y = +a[3]; }
  else if ((a = s.match(/^(\d{1,2})-([A-Za-z]+)\.?-(\d{4})$/))) { m = MONTHS.findIndex((x) => x.startsWith(a[2].toLowerCase().slice(0, 3))) + 1; d = +a[1]; y = +a[3]; }
  else if ((a = s.match(/^(\d{1,2}) ([A-Za-z]+)\.?,? (\d{4})$/))) { m = MONTHS.findIndex((x) => x.startsWith(a[2].toLowerCase().slice(0, 3))) + 1; d = +a[1]; y = +a[3]; }
  else if (CFG.fx && parseFxDate(s)) return parseFxDate(s);
  else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export const moneyNum = (s) => {
  let t = String(s).trim();
  if (CFG.fx && isFxMoney(t)) return fxMoneyNum(t);
  if (CFG.cur) { t = t.replace(/[A-Za-z$\u20ac\u00a3\s]/g, ""); if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", "."); else t = t.replace(/,/g, ""); }
  else t = t.replace(/[$,\s]/g, "");
  const n = parseFloat(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
// classify a raw value by its own shape
export function valueType(v) {
  v = String(v).trim(); if (!v) return "empty";
  if (CFG.cur && MONEY_FULL.test(v)) return "money";
  if (CFG.fx && isFxMoney(v)) return "money";
  if (/^\$\s?\d[\d,]*(\.\d{1,2})?$/.test(v) || /^\d{1,3}(,\d{3})+(\.\d{2})?$/.test(v) || /^\d+\.\d{2}$/.test(v)) return "money";
  if (parseDate(v)) return "date";
  if (/^\d+(\.\d+)?%$/.test(v)) return "percent";
  if (/^\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}$/.test(v)) return "phone";
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) return "email";
  if (/^\d+$/.test(v)) return "int";
  if (/^\d+(\.\d+)?$/.test(v)) return "number";
  if (/^[A-Za-z]{0,8}[-_# ]?[A-Za-z0-9]*\d[A-Za-z0-9]*([-_][A-Za-z0-9]+)*$/.test(v) && !/\s/.test(v) && /[A-Za-z]/.test(v) ) return "id";
  if (/^[A-Z][\w.'&-]*( [A-Za-z][\w.'&,-]*){0,6}$/.test(v) && /^[^$\d]*$/.test(v)) return "name";
  return "text";
}
