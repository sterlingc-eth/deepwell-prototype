/**
 * R34 (break-it, Donovan) - calendar spans no other resolver recognized, and every one of them used to fail the SAME way:
 * the question named a date window, no resolver claimed it, so the plan silently dropped the window and answered with the
 * WHOLE unfiltered total ("how many service tickets in 2020" -> "You have 120 documents."; "how many invoices between 2020
 * and 2022" -> "We have 120 invoices on file."; "how many units installed before 2015" -> "132 pieces of equipment").
 *
 * One pure module, shared by analytics.js (resolveAnyTimeRange) and financials/answers.js (parsePeriod) so the two engines can
 * never disagree about what "Q1 2026" or "the 2010s" means. Returns:
 *   {from, to, label}                  inclusive ISO day bounds (day grain)
 *   {invalid: true, text}              the question names a date that does not exist ("September 31", "4/31/2026", "Feb 30 2027")
 *   null                               nothing here (callers fall through to their own families)
 * No I/O, no model. Only families whose meaning is unambiguous are handled.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const monthNum = (w) => MONTHS.findIndex((m) => m.startsWith(String(w).toLowerCase().slice(0, 3))) + 1;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);
const year4 = (s) => Number(s);

const DAY_FIRST_RE = new RegExp(`\\b(?:on\\s+|dated\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\b\\.?,?(?:\\s+(\\d{4}))?`, 'i');
const MONTH_FIRST_RE = new RegExp(`\\b(${MONTH_ALT})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:years?|yrs?|days?|months?|weeks?|%|units?|tons?|invoices?|jobs?))(?:,?\\s+(\\d{4}))?`, 'i');
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/** All explicit calendar dates in the question as {y,m,d,text}; y may be null when none was typed. */
function explicitDates(q) {
  const out = [];
  let m;
  if ((m = q.match(ISO_DATE_RE))) out.push({ y: year4(m[1]), m: Number(m[2]), d: Number(m[3]), text: m[0] });
  else if ((m = q.match(NUMERIC_DATE_RE))) {
    const yy = m[3].length === 2 ? 2000 + Number(m[3]) : year4(m[3]);
    out.push({ y: yy, m: Number(m[1]), d: Number(m[2]), text: m[0] });
  } else if ((m = q.match(MONTH_FIRST_RE))) {
    out.push({ y: m[3] ? year4(m[3]) : null, m: monthNum(m[1]), d: Number(m[2]), text: m[0].trim() });
  } else if ((m = q.match(DAY_FIRST_RE))) {
    out.push({ y: m[3] ? year4(m[3]) : null, m: monthNum(m[2]), d: Number(m[1]), text: m[0].trim() });
  }
  return out;
}

const cap = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;
const fmtLong = (y, m, d) => `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;

export function findInvalidDate(question) {
  const q = String(question ?? '').toLowerCase();
  for (const dt of explicitDates(q)) {
    const y = dt.y ?? 2024; // a year-less "February 29" is judged against a leap year; "September 31" is invalid in any year
    if (dt.d > 31 || dt.m < 1 || dt.m > 12 || !validDay(y, dt.m, dt.d)) {
      // numeric d/m ambiguity: "21/9/2026" is a legal day-first date, never flag it
      if (/\//.test(dt.text) && dt.m > 12 && dt.d <= 12) continue;
      return { invalid: true, text: dt.text };
    }
    if (dt.y != null && dt.m === 2 && dt.d === 29 && !validDay(dt.y, 2, 29)) return { invalid: true, text: dt.text };
  }
  return null;
}

/**
 * @param {string} question
 * @param {string} today ISO date (YYYY-MM-DD...)
 * @returns {{from:string,to:string,label:string}|{invalid:true,text:string}|null}
 */
export function resolveCalendarSpan(question, today) {
  const q = String(question ?? '').toLowerCase();
  const t = new Date(today ?? Date.now());
  if (Number.isNaN(t.getTime())) return null;
  const Y = t.getUTCFullYear();
  const todayISO = t.toISOString().slice(0, 10);
  const yesterday = new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
  let m;

  const bad = findInvalidDate(q);
  if (bad) return bad;

  // One specific day: "on September 21, 2026", "on 9/21/2026", "21 September 2026", "2026-09-21", "on March 3" (this year).
  const dts = explicitDates(q);
  if (dts.length) {
    const dt = dts[0];
    let y = dt.y;
    if (y == null) {
      y = Y;
      if (iso(y, dt.m, dt.d) > todayISO) y -= 1; // same "not a day that hasn't happened yet" rule bare month names follow
    }
    // "march 15th, 2027" etc: a real future day stays a future day (callers decide), never rewritten.
    const day = iso(y, dt.m, dt.d);
    // A date with a direction word is a half-open window, never a single day: "since January 1st", "before March 3rd", "after 9/21/2026".
    const lead = q.slice(0, q.indexOf(dt.text.toLowerCase())).replace(/\b(?:on|of|the|day)\s*$/g, '').trim();
    const dirWord = /\b(since|before|prior to|after|until|till|through|thru|by|from|starting|beginning)\s*$/.exec(lead)?.[1];
    if (dirWord) {
      const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      if (dirWord === 'since' || dirWord === 'from' || dirWord === 'starting' || dirWord === 'beginning') return { from: day, to: todayISO, label: `since ${fmtLong(y, dt.m, dt.d)}`, bare: `since ${fmtLong(y, dt.m, dt.d)}` };
      if (dirWord === 'before' || dirWord === 'prior to') return { from: '1900-01-01', to: prev, label: `before ${fmtLong(y, dt.m, dt.d)}`, bare: `before ${fmtLong(y, dt.m, dt.d)}` };
      if (dirWord === 'after') return { from: next, to: todayISO > next ? todayISO : next, label: `after ${fmtLong(y, dt.m, dt.d)}`, bare: `after ${fmtLong(y, dt.m, dt.d)}` };
      return { from: '1900-01-01', to: day, label: `through ${fmtLong(y, dt.m, dt.d)}`, bare: `through ${fmtLong(y, dt.m, dt.d)}` };
    }
    return { from: day, to: day, label: `on ${fmtLong(y, dt.m, dt.d)}`, bare: fmtLong(y, dt.m, dt.d) };
  }

  if (/\btoday\b/.test(q) && !/\btoday'?s\s+(?:date|prices?)\b/.test(q)) return { from: todayISO, to: todayISO, label: 'today', bare: `${fmtLong(Y, t.getUTCMonth() + 1, t.getUTCDate())} (today)` };
  if (/\byesterday\b/.test(q)) return { from: yesterday, to: yesterday, label: 'yesterday', bare: fmtLong(Number(yesterday.slice(0, 4)), Number(yesterday.slice(5, 7)), Number(yesterday.slice(8, 10))) };

  // Forward windows: "next year", "next month", "next quarter" (calendar-aligned, not rolling).
  if (/\bnext\s+year\b/.test(q)) return { from: iso(Y + 1, 1, 1), to: iso(Y + 1, 12, 31), label: `in ${Y + 1}`, bare: String(Y + 1) };
  if (/\bnext\s+month\b/.test(q)) {
    const mm = t.getUTCMonth() + 2; const yy = mm > 12 ? Y + 1 : Y; const m2 = mm > 12 ? 1 : mm;
    return { from: iso(yy, m2, 1), to: iso(yy, m2, lastDay(yy, m2)), label: `in ${cap(MONTHS[m2 - 1])} ${yy}`, bare: `${cap(MONTHS[m2 - 1])} ${yy}` };
  }
  if (/\bnext\s+quarter\b/.test(q)) {
    const cq = Math.floor(t.getUTCMonth() / 3) + 1; const nq = cq === 4 ? 1 : cq + 1; const yy = cq === 4 ? Y + 1 : Y;
    return quarter(nq, yy);
  }

  // Quarters: "Q1 2026", "q3 of 2025", "the first quarter of 2026", "second quarter 2025".
  if ((m = q.match(/\bq([1-4])\s*(?:of\s+)?(?:fy\s*)?(\d{4})\b/))) return quarter(Number(m[1]), year4(m[2]));
  const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
  if ((m = q.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th)\s+quarter\s+(?:of\s+)?(\d{4})\b/))) return quarter(ORD[m[1]], year4(m[2]));

  // Decades: "the 2010s", "in the 1990s".
  if ((m = q.match(/\b(?:the\s+)?(19|20)(\d)0'?s\b/))) {
    const y0 = Number(`${m[1]}${m[2]}0`);
    return { from: iso(y0, 1, 1), to: iso(y0 + 9, 12, 31), label: `in the ${y0}s`, bare: `the ${y0}s` };
  }

  // Year ranges: "between 2020 and 2022", "from 2018 to 2019", "2018-2020", "2018 through 2020".
  if ((m = q.match(/\b(?:between|from)\s+(?:the\s+year\s+)?(\d{4})\s+(?:and|to|through|thru|until|till)\s+(\d{4})\b/)) || (m = q.match(/\b(\d{4})\s*(?:-|–|to|through|thru)\s*(\d{4})\b/))) {
    let a = year4(m[1]); let b = year4(m[2]);
    if (a > b) [a, b] = [b, a];
    return { from: iso(a, 1, 1), to: iso(b, 12, 31), label: `${a} through ${b}`, bare: `${a} through ${b}` };
  }

  // "between March and May [2024]" / "from March to May 2024"
  if ((m = q.match(new RegExp(`\\b(?:between|from)\\s+(${MONTH_ALT})\\b\\.?\\s+(?:and|to|through|thru)\\s+(${MONTH_ALT})\\b\\.?(?:[\\s,]+(?:of\\s+)?(\\d{4}))?`)))) {
    const a = monthNum(m[1]); const b = monthNum(m[2]);
    let y = m[3] ? year4(m[3]) : Y;
    if (!m[3] && iso(y, a, 1) > todayISO) y -= 1;
    const yb = b < a ? y + 1 : y;
    return { from: iso(y, a, 1), to: iso(yb, b, lastDay(yb, b)), label: `${cap(MONTHS[a - 1])} through ${cap(MONTHS[b - 1])} ${yb}`, bare: `${cap(MONTHS[a - 1])} through ${cap(MONTHS[b - 1])} ${yb}` };
  }

  // Abbreviated / any month name + year ("feb 2024", "Sept 2023") - the long-name resolver already handles full names.
  if ((m = q.match(new RegExp(`\\b(${MONTH_ALT})\\b\\.?[\\s,]+(?:of\\s+)?(\\d{4})\\b`)))) {
    const mo = monthNum(m[1]); const y = year4(m[2]);
    return { from: iso(y, mo, 1), to: iso(y, mo, lastDay(y, mo)), label: `in ${cap(MONTHS[mo - 1])} ${y}`, bare: `${cap(MONTHS[mo - 1])} ${y}` };
  }

  // before / after a bare year: "installed before 2015", "invoices after 2024". After Y means from Jan 1 of Y+1.
  if ((m = q.match(/\b(?:before|prior to|earlier than)\s+(?:the\s+year\s+)?(\d{4})\b/))) {
    const y = year4(m[1]);
    return { from: '1900-01-01', to: iso(y - 1, 12, 31), label: `before ${y}`, bare: `the years before ${y}` };
  }
  if ((m = q.match(/\b(?:after|later than)\s+(?:the\s+year\s+)?(\d{4})\b/))) {
    const y = year4(m[1]);
    return { from: iso(y + 1, 1, 1), to: iso(Math.max(y + 1, Y), 12, 31) > todayISO ? todayISO : iso(Math.max(y + 1, Y), 12, 31), label: `after ${y}`, bare: `the years after ${y}` };
  }

  // A bare year: "in 2020", "for 2020", "during 2020", "of 2020", "2020 service tickets".
  if ((m = q.match(/\b(?:in|for|during|of|from|year)\s+(?:the\s+year\s+)?(\d{4})\b(?!\s*(?:-|to|through|and)\s*\d)/))) {
    const y = year4(m[1]);
    if (y >= 1990 && y <= 2100) return { from: iso(y, 1, 1), to: iso(y, 12, 31), label: `in ${y}`, bare: String(y) };
  }
  return null;
}

function quarter(n, y) {
  const sm = (n - 1) * 3 + 1;
  return { from: iso(y, sm, 1), to: iso(y, sm + 2, lastDay(y, sm + 2)), label: `in Q${n} ${y}`, bare: `Q${n} ${y}` };
}
