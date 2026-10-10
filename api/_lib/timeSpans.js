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
// Slash dates may carry a 2-digit year; dotted dates ("9.21.2026", "9.21.26", "21.09.2026") too, but a dotted run of more than three numbers (a version / part number) is never a date.
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b|(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b(?!\.\d)/;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// Year-first dates with dot or slash separators ("2026.09.21", "2026/9/21"): the month must be a real month, so a version-like "2026.25.3" is never a date.
const YMD_SEP_RE = /\b(\d{4})([./])(0?[1-9]|1[0-2])\2(\d{1,2})\b/;

/** All explicit calendar dates in the question as {y,m,d,text}; y may be null when none was typed. */
function explicitDates(q) {
  const out = [];
  let m;
  if ((m = q.match(ISO_DATE_RE))) out.push({ y: year4(m[1]), m: Number(m[2]), d: Number(m[3]), text: m[0] });
  else if ((m = q.match(YMD_SEP_RE))) out.push({ y: year4(m[1]), m: Number(m[3]), d: Number(m[4]), text: m[0] });
  else if ((m = q.match(NUMERIC_DATE_RE))) {
    const a = m[1] ?? m[4]; const b = m[2] ?? m[5]; const yr = m[3] ?? m[6];
    const yy = yr.length === 2 ? 2000 + Number(yr) : year4(yr);
    // 9/21/2026 is month-first; "21/09/2026" / "21.09.2026" can only be day-first (21 is not a month) and is read that way.
    if (Number(a) > 12 && Number(b) <= 12) out.push({ y: yy, m: Number(b), d: Number(a), text: m[0] });
    else out.push({ y: yy, m: Number(a), d: Number(b), text: m[0] });
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

  // Two numeric/ISO dates joined by between..and / from..to ("between 9/14/2026 and 9/20/2026", "from 2026-09-01 to 2026-09-15") are one
  // inclusive window, never the first date alone (DONOVAN_REL_WINDOW=0 restores the single-day read).
  if (process.env.DONOVAN_REL_WINDOW !== '0' && (m = q.match(/\b(?:between|from)\s+(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s+(?:and|to|through|thru|until)\s+(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/))) {
    const one = (x) => { const a = x.match(ISO_DATE_RE) ?? x.match(NUMERIC_DATE_RE); return ISO_DATE_RE.test(x) ? { y: Number(a[1]), m: Number(a[2]), d: Number(a[3]) } : { y: Number(a[3]), m: Number(a[1]), d: Number(a[2]) }; };
    const [a, b] = [one(m[1]), one(m[2])];
    if (validDay(a.y, a.m, a.d) && validDay(b.y, b.m, b.d)) {
      let [x, y] = [iso(a.y, a.m, a.d), iso(b.y, b.m, b.d)]; let [da, db] = [a, b];
      if (x > y) { [x, y] = [y, x]; [da, db] = [b, a]; }
      const lab = `${fmtLong(da.y, da.m, da.d)} through ${fmtLong(db.y, db.m, db.d)}`;
      return { from: x, to: y, label: `from ${lab}`, bare: lab };
    }
  }
  // Two explicit dates joined by a range word: "between 9/1/2026 and 9/15/2026", "from March 3 to March 9, 2026". Checked BEFORE the single-day
  // reading below, which would otherwise keep only the first date and answer for one day (a collapsed range).
  const DATE_ALT = `(?:\\d{4}[./-]\\d{1,2}[./-]\\d{1,2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}|(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_ALT})\\.?(?:,?\\s+\\d{4})?)`;
  if ((m = q.match(new RegExp(`\\b(?:between|from)\\s+(${DATE_ALT})\\s+(?:and|to|through|thru|until|till|-|–)\\s+(${DATE_ALT})`)))) {
    const d1 = explicitDates(m[1])[0]; const d2 = explicitDates(m[2])[0];
    if (d1 && d2) {
      const y2 = d2.y ?? d1.y ?? Y; const y1 = d1.y ?? y2;
      let a = iso(y1, d1.m, d1.d); let b = iso(y2, d2.m, d2.d);
      if (a > b) [a, b] = [b, a];
      const [ya, ma, da] = a.split('-').map(Number); const [yb, mb, db] = b.split('-').map(Number);
      return { from: a, to: b, label: `from ${fmtLong(ya, ma, da)} through ${fmtLong(yb, mb, db)}`, bare: `${fmtLong(ya, ma, da)} through ${fmtLong(yb, mb, db)}` };
    }
  }

  // One specific day: "on September 21, 2026", "on 9/21/2026", "21 September 2026", "2026-09-21", "on March 3" (this year).
  const dts = explicitDates(q);
  if (dts.length) {
    const dt = dts[0];
    let y = dt.y;
    let yearNote = '';
    if (y == null) {
      y = Y;
      if (iso(y, dt.m, dt.d) > todayISO) y -= 1; // same "not a day that hasn't happened yet" rule bare month names follow
      // E2 A7: "before december 24" / "after march 3" with no year takes the year whose date is NEAREST to today (either side), and says so; a plain or "since" date keeps the most-recent-past reading.
      const pre = q.slice(0, q.indexOf(dt.text.toLowerCase())).replace(/\b(?:on|of|the|day)\s*$/g, '').trim();
      const isDir = /\b(before|prior to|until|till|by)\s*$/.test(pre); // "after <date>" keeps the most recent past one: nothing can be after a future day
      if (isDir) {
        const cand = [Y - 1, Y, Y + 1].map((yy) => ({ yy, diff: Math.abs(Date.parse(`${iso(yy, dt.m, dt.d)}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) }));
        y = cand.sort((a, b) => a.diff - b.diff)[0].yy;
      }
      void yearNote; // the chosen year is part of every label ("before December 24, 2026"), which is how the answer states it
    }
    // "march 15th, 2027" etc: a real future day stays a future day (callers decide), never rewritten.
    const day = iso(y, dt.m, dt.d);
    // A date with a direction word is a half-open window, never a single day: "since January 1st", "before March 3rd", "after 9/21/2026".
    const lead = q.slice(0, q.indexOf(dt.text.toLowerCase())).replace(/\b(?:on|of|the|day)\s*$/g, '').trim();
    const dirWord = /\b(since|before|prior to|after|until|till|through|thru|by|from|starting|beginning)\s*$/.exec(lead)?.[1];
    if (dirWord) {
      const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      if (dirWord === 'since' || dirWord === 'from' || dirWord === 'starting' || dirWord === 'beginning') return { from: day, to: todayISO, label: `since ${fmtLong(y, dt.m, dt.d)}${yearNote}`, bare: `since ${fmtLong(y, dt.m, dt.d)}` };
      if (dirWord === 'before' || dirWord === 'prior to') return { from: '1900-01-01', to: prev, label: `before ${fmtLong(y, dt.m, dt.d)}${yearNote}`, bare: `before ${fmtLong(y, dt.m, dt.d)}` };
      if (dirWord === 'after') return { from: next, to: todayISO > next ? todayISO : next, label: `after ${fmtLong(y, dt.m, dt.d)}${yearNote}`, bare: `after ${fmtLong(y, dt.m, dt.d)}` };
      return { from: '1900-01-01', to: day, label: `through ${fmtLong(y, dt.m, dt.d)}${yearNote}`, bare: `through ${fmtLong(y, dt.m, dt.d)}` };
    }
    return { from: day, to: day, label: `on ${fmtLong(y, dt.m, dt.d)}${yearNote}`, bare: fmtLong(y, dt.m, dt.d) };
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

  // B3 halves: "the first half of 2025", "second half 2025", "H1 2025", "first half of last year" (a half is its own window, never the whole year).
  {
    const HALF = { first: 1, '1st': 1, h1: 1, second: 2, '2nd': 2, h2: 2, last: 2 };
    const hm = q.match(/\b(first|1st|second|2nd|last)\s+half\s+(?:of\s+)?(?:the\s+year\s+)?(\d{4}|this\s+year|last\s+year)\b/) || q.match(/\b(h1|h2)\s*(?:of\s+)?(?:fy\s*)?(\d{4})\b/);
    if (hm) {
      const yy = /^\d{4}$/.test(hm[2]) ? year4(hm[2]) : /last/.test(hm[2]) ? Y - 1 : Y;
      const h = HALF[hm[1]];
      const [a, b] = h === 1 ? [iso(yy, 1, 1), iso(yy, 6, 30)] : [iso(yy, 7, 1), iso(yy, 12, 31)];
      const nm = h === 1 ? 'first' : 'second';
      return { from: a, to: b, label: `in the ${nm} half of ${yy}`, bare: `the ${nm} half of ${yy}` };
    }
  }
  // "the year before last" = two calendar years back.
  if (/\b(?:the\s+)?year\s+before\s+last\b/.test(q)) return { from: iso(Y - 2, 1, 1), to: iso(Y - 2, 12, 31), label: `in ${Y - 2}`, bare: String(Y - 2) };
  // Two consecutive years taken together: "2021 and 2022 combined", "2021 and 2022 all together" (non-consecutive years are two windows, not one: left alone).
  if ((m = q.match(/\b((?:19|20)\d{2})\s+(?:and|&|plus)\s+((?:19|20)\d{2})\s+(?:combined|together|all\s+together|in\s+total|altogether)\b/)) && Math.abs(Number(m[1]) - Number(m[2])) === 1) {
    const a = Math.min(Number(m[1]), Number(m[2])); const b = Math.max(Number(m[1]), Number(m[2]));
    return { from: iso(a, 1, 1), to: iso(b, 12, 31), label: `${a} through ${b}`, bare: `${a} through ${b}` };
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
    // A reversed range ("between 2012 and 2010") is read oldest-to-newest and the answer says so (DONOVAN_REVERSED_RANGE=0 restores the silent swap).
    const rev = a > b && process.env.DONOVAN_REVERSED_RANGE !== '0';
    if (a > b) [a, b] = [b, a];
    const note = rev ? ' (the range was typed in reverse, so I read it oldest to newest)' : '';
    return { from: iso(a, 1, 1), to: iso(b, 12, 31), label: `${a} through ${b}${note}`, bare: `${a} through ${b}${note}` };
  }

  // "between March and May [2024]" / "from March to May 2024"
  if ((m = q.match(new RegExp(`\\b(?:between|from)\\s+(${MONTH_ALT})\\b\\.?\\s+(?:and|to|through|thru)\\s+(${MONTH_ALT})\\b\\.?(?:[\\s,]+(?:of\\s+)?(\\d{4}))?`)))) {
    const a = monthNum(m[1]); const b = monthNum(m[2]);
    let y = m[3] ? year4(m[3]) : Y;
    if (!m[3] && iso(y, a, 1) > todayISO) y -= 1;
    const yb = b < a ? y + 1 : y;
    return { from: iso(y, a, 1), to: iso(yb, b, lastDay(yb, b)), label: `${cap(MONTHS[a - 1])} through ${cap(MONTHS[b - 1])} ${yb}`, bare: `${cap(MONTHS[a - 1])} through ${cap(MONTHS[b - 1])} ${yb}` };
  }

  // Month + year on BOTH ends: "between January 2020 and December 2021", "from March 2019 to May 2019", "Jan 2010 - Dec 2012".
  // (Without this the first "Month YYYY" below was kept alone and the question answered for one month.)
  {
    const MY = `(${MONTH_ALT})\\b\\.?(?:[\\s,]+(?:of\\s+)?(\\d{4}))?`;
    const SEP = '\\s*(?:and|to|through|thru|until|till|-|–|—)\\s*';
    const withPrefix = q.match(new RegExp(`\\b(?:between|from)\\s+${MY}${SEP}${MY}`));
    const SEP2 = '\\s*(?:to|through|thru|until|till|-|–|—)\\s*'; // no "and" without between/from: "March 2019 and May 2019" names two months, not the span
    const noPrefix = q.match(new RegExp(`\\b${MY.replace('(?:[\\s,]+(?:of\\s+)?(\\d{4}))?', '[\\s,]+(?:of\\s+)?(\\d{4})')}${SEP2}${MY.replace('(?:[\\s,]+(?:of\\s+)?(\\d{4}))?', '[\\s,]+(?:of\\s+)?(\\d{4})')}`));
    const mm = withPrefix && withPrefix[2] ? withPrefix : noPrefix;
    if (mm && mm[2]) {
      let a = monthNum(mm[1]); let b = monthNum(mm[3]);
      let y1 = year4(mm[2]); let y2 = mm[4] ? year4(mm[4]) : y1;
      if (!mm[4] && b < a) y2 = y1 + 1;
      if (y1 * 12 + a > y2 * 12 + b) { [a, b] = [b, a]; [y1, y2] = [y2, y1]; } // reversed range
      const text = `${cap(MONTHS[a - 1])} ${y1} through ${cap(MONTHS[b - 1])} ${y2}`;
      return { from: iso(y1, a, 1), to: iso(y2, b, lastDay(y2, b)), label: `from ${text}`, bare: text };
    }
  }
  // Numeric month ranges: "between 3/2019 and 5/2019".
  if ((m = q.match(/\b(?:between|from)\s+(\d{1,2})[/.](\d{4})\s*(?:and|to|through|thru|until|till|-|–)\s*(\d{1,2})[/.](\d{4})\b/)) && m[1] >= 1 && m[1] <= 12 && m[3] >= 1 && m[3] <= 12) {
    let a = [year4(m[2]), Number(m[1])]; let b = [year4(m[4]), Number(m[3])];
    if (a[0] * 12 + a[1] > b[0] * 12 + b[1]) [a, b] = [b, a];
    return { from: iso(a[0], a[1], 1), to: iso(b[0], b[1], lastDay(b[0], b[1])), label: `from ${cap(MONTHS[a[1] - 1])} ${a[0]} through ${cap(MONTHS[b[1] - 1])} ${b[0]}`, bare: `${cap(MONTHS[a[1] - 1])} ${a[0]} through ${cap(MONTHS[b[1] - 1])} ${b[0]}` };
  }
  // A numeric month: "9/2026", "09/2026", "9.2026", "2026/09", "2026.9", "2026-09" (a full date was already handled above).
  {
    const my = q.match(/(?<![\d/.-])(0?[1-9]|1[0-2])[/.](\d{4})(?![\d/])/) ?? null;
    const ym = my ? null : q.match(/(?<![\d/.-])(\d{4})[/.-](0?[1-9]|1[0-2])(?![\d/.-]|\d)/);
    const yy = my ? year4(my[2]) : ym ? year4(ym[1]) : null; const mo = my ? Number(my[1]) : ym ? Number(ym[2]) : null;
    if (yy && mo && yy >= 1990 && yy <= 2100) return { from: iso(yy, mo, 1), to: iso(yy, mo, lastDay(yy, mo)), label: `in ${cap(MONTHS[mo - 1])} ${yy}`, bare: `${cap(MONTHS[mo - 1])} ${yy}` };
  }
  // Month name with NO year (DONOVAN_MONTH_NOYEAR=0 disables): resolves to the most recent such month that is not in the future
  // relative to `today` ("sept" on 2026-09-25 -> September 2026, "october" -> October 2025). "since <month> [year]" runs from the
  // 1st of that month to today. Needs a lead-in word so the verb "may" / "march on" never reads as a month.
  if (process.env.DONOVAN_MONTH_NOYEAR !== '0') {
    const LEAD = '(?:in|during|for|of|from|on|within|throughout|since|starting|beginning)';
    const noPrefix = (idx) => !/\b(?:last|this|next|every|each|past|previous|prior|coming)\s+(?:the\s+)?(?:month\s+of\s+)?$/.test(q.slice(Math.max(0, idx - 24), idx));
    if ((m = q.match(new RegExp(`\\bsince\\s+(?:the\\s+(?:start|beginning)\\s+of\\s+)?(?:the\\s+month\\s+of\\s+)?(${MONTH_ALT})\\b\\.?(?:[\\s,]+(?:of\\s+)?(\\d{4})\\b)?`))) && noPrefix(m.index)) {
      const mo = monthNum(m[1]); let y = m[2] ? year4(m[2]) : Y;
      if (!m[2] && iso(y, mo, 1) > todayISO) y -= 1;
      const from = iso(y, mo, 1);
      if (from <= todayISO) return { from, to: todayISO, label: `since ${cap(MONTHS[mo - 1])} 1, ${y}`, bare: `since ${cap(MONTHS[mo - 1])} 1, ${y}` };
    }
    if ((m = q.match(new RegExp(`\\b${LEAD}\\s+(?:the\\s+month\\s+of\\s+)?(${MONTH_ALT})\\b\\.?(?![\\s,]+(?:of\\s+)?\\d)`))) && noPrefix(m.index)) {
      const mo = monthNum(m[1]); let y = Y;
      if (iso(y, mo, 1) > todayISO) y -= 1;
      return { from: iso(y, mo, 1), to: iso(y, mo, lastDay(y, mo)), label: `in ${cap(MONTHS[mo - 1])} ${y}`, bare: `${cap(MONTHS[mo - 1])} ${y}` };
    }
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
