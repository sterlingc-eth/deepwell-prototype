/**
 * The sensitive-field rule for the public demo (same rule the real answer layer applies: a number that identifies a person or an
 * account is shown as "on file" + its LAST 4 characters, and a birth date / SSN is never shown at all).
 *
 * Applied in two places, both before anything leaves the server:
 *   - maskField(key, value)   every extracted field the visitor sees
 *   - maskText(text)          the page text kept in the visitor's browser tab and handed to the question model, so a model that
 *                             only ever sees masked text cannot repeat a value it was never given.
 *
 * Pure. No logging.
 */

/** Field keys whose value is a person / account identifier: shown as last 4 only. */
const LAST4_KEY_RE = /(?:^|_)(?:ssn|social|sin|tin|ein|tax_?id|passport|account|acct|routing|iban|card|pan|cvv|license_number|licence_number|driver_license|drivers_license|driver_licence|license|licence|examiner_license_number|dl_number|dln|id_number|member_?id|policy_number|employee_number|badge|permit_number|registry|vin)(?:$|_)/i;
/** Field keys that are never shown, not even partly. */
const HIDDEN_KEY_RE = /(?:^|_)(?:dob|birth|birthday|bday|birthdate|date_of_birth|born|ssn|social_security)(?:$|_)/i;

const alnum = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');

/** "XXXX5789" / "123-45-6789" / "4111 1111 1111 1111" -> "•••• 6789". Fewer than 5 characters: "•••• on file". */
export function last4(value) {
  const a = alnum(value);
  return a.length >= 5 ? `•••• ${a.slice(-4)}` : '•••• on file';
}

/** @returns {{value: string|null, masked: boolean}}  value null = hide the field completely */
export function maskField(key, value, opts = {}) {
  const k = String(key ?? '');
  const v = String(value ?? '');
  if (HIDDEN_KEY_RE.test(k)) return { value: null, masked: true };
  if (LAST4_KEY_RE.test(k)) return { value: last4(v), masked: true };
  const t = maskText(v, opts);
  return { value: t, masked: t !== v };
}

/** Does this label say the number that follows identifies a person or an account? */
const ID_LABEL = '(?:social\\s+security(?:\\s+(?:number|no\\.?|#))?|ssn|ss#|tax\\s+id|taxpayer\\s+id(?:entification)?(?:\\s+(?:number|no\\.?|#))?|ein|passport(?:\\s+(?:number|no\\.?|#))?|bank\\s+account(?:\\s+(?:number|no\\.?|#))?|account(?:\\s+(?:number|no\\.?|#))?|acct\\.?(?:\\s+(?:number|no\\.?|#))?|routing(?:\\s+(?:number|no\\.?|#))?|aba|iban|card(?:\\s+(?:number|no\\.?|#))?|credit\\s+card|debit\\s+card|dl(?:\\s+(?:number|no\\.?|#))?|dln|driver\'?s?\\s+licen[cs]e(?:\\s+(?:number|no\\.?|#))?|licen[cs]e(?:\\s+(?:number|no\\.?|#))?|lic\\.?\\s*(?:no\\.?|#)|id(?:\\s+(?:number|no\\.?|#))|member\\s+(?:id|number|no\\.?|#)|policy(?:\\s+(?:number|no\\.?|#))|employee\\s+(?:id|number|no\\.?|#)|permit(?:\\s+(?:number|no\\.?|#))|vin)';
const LABELLED_ID_RE = new RegExp(`(\\b${ID_LABEL}\\s*[:#=\\-–]?\\s*)([A-Za-z0-9*Xx•][A-Za-z0-9*Xx•\\- ]{3,30}[A-Za-z0-9])`, 'gi');
/**
 * Every way a page labels a birth date. This list is the DEMO'S OWN and deliberately wider than the app's licence-structure test
 * (modelAvoidance/peopleShape.js, which is left exactly as it was so the real reader's rules do not change): over-masking a label here only
 * hides more of a visitor's own paper, never changes what the real app reads.
 */
const DOB_LABEL_SRC = 'd\\.?\\s?o\\.?\\s?b\\.?|date\\s+of\\s+birth|birth\\s*date|birth\\s*day|b-?day|date\\s+born|born(?:\\s+on)?|birth|geburts\\s*datum|geburts\\s*tag|geboren(?:\\s+am)?|geb\\.|fecha\\s+de\\s+nacimiento|fecha\\s+(?:de\\s+)?nac\\.?|f\\.\\s*nac\\.?|nacimiento|nacido(?:\\s+el)?|date\\s+de\\s+naissance|naissance|n(?:é|e)e?\\s+le|data\\s+de\\s+nascimento|data\\s+(?:de\\s+)?nasc\\.?|nascid[oa]\\s+em|nascimento|data\\s+di\\s+nascita|nascita|nat[oa]\\s+il|geboortedatum|geboorte\\s*datum|geboren\\s+op|geb\\.?\\s*datum';
// A date in any common shape: 03/03/1985, 3-3-85, 03 / 03 / 1985, 03.03.1985, 1985-03-03, 1985/03/03, March 3rd, 1985, 3 March 1985, 3-Mar-85,
// Mar 1985, 03/1985, 03031985, 19850303, 030385, or just a year. Only ever matched right after a birth-date label.
const MON = '(?:jan(?:uary|uar|uari|vier)?|janv|jän|gen(?:naio)?|ene(?:ro)?|feb(?:ruary|ruar|ruari|rero|braio)?|f(?:é|e)v(?:rier)?|f(?:é|e)vr|fev(?:ereiro)?|mar(?:ch|zo|s)?|m(?:ä|ae)rz|maart|mrt|mar(?:ç|c)o|apr(?:il|ile)?|abr(?:il)?|avr(?:il)?|may(?:o)?|mai|mei|mag(?:gio)?|maio|jun(?:e|i|io|ho)?|juin|giu(?:gno)?|jul(?:y|i|io|ho)?|juil(?:let)?|lug(?:lio)?|aug(?:ust|ustus)?|ago(?:sto)?|ao(?:û|u)t|sep(?:t(?:ember|iembre|embre)?|tiembre)?|set(?:iembre|tembre|embro)?|oct(?:ober|ubre|obre)?|okt(?:ober)?|ott(?:obre)?|out(?:ubro)?|nov(?:ember|iembre|embre|embro)?|dec(?:ember|embre)?|dez(?:ember|embro)?|d(?:é|e)c(?:embre)?|dic(?:iembre|embre)?)';
const DATE_SRC = [
  String.raw`\d{1,2}\s?[\/.\-]\s?\d{1,2}\s?[\/.\-]\s?\d{2,4}`,
  String.raw`\d{4}\s?[\/.\-]\s?\d{1,2}\s?[\/.\-]\s?\d{1,2}`,
  String.raw`${MON}\.?[\s\-.]*\d{1,2}(?:st|nd|rd|th)?,?[\s\-.]*\d{2,4}`,
  String.raw`\d{1,2}(?:st|nd|rd|th|\.)?(?:\s+(?:of|de|di))?[\s\-.]*${MON}\.?(?:\s+(?:de|del|di))?,?[\s\-.]*\d{2,4}`,
  String.raw`${MON}\.?(?:\s+(?:de|del|di))?,?[\s\-.]*\d{4}`,
  String.raw`\d{1,2}\s?\/\s?\d{4}`,
  String.raw`\d{8}`, String.raw`\d{6}`, String.raw`(?:19|20)\d{2}`,
].join('|');
const DOB_RE = new RegExp(String.raw`((?<![A-Za-z])(?:${DOB_LABEL_SRC})(?![A-Za-z])(?:\s*\([^)]{0,30}\))?[\s:#=\-–—―‒._·…•*]*(?:[^\W\d_]+(?:\s+[^\W\d_]+)?\s*,\s*){0,2})(?:${DATE_SRC})(?![\d])`, 'gi');
const SSN_RE = /\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const LONG_DIGITS_RE = /\b\d{9,}\b/g;
// 10-digit phone shapes stay readable: a business paper needs its phone numbers
const PHONE_SHAPE_RE = /^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/;
// on a person-ID paper only a phone with separators is a phone; ten bare digits on a card line are a license number
const PHONE_FORMATTED_RE = /^\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}$/;

/**
 * Labelled ID values ("Account No: 123456789", "DL 123-45-6789") keep only their last 4.
 * A label followed by something that has no digit at all (a heading, a word) is left alone.
 */
function maskLabelled(text) {
  return text.replace(LABELLED_ID_RE, (m, label, val) => {
    const digits = (val.match(/\d/g) ?? []).length;
    if (digits < 3) return m; // "Account: Savings", "License: Class B"
    if (/\$|\.\d\d\b/.test(val)) return m; // an amount, not an identifier
    // the value is the leading run of tokens that look like part of a number; words after it ("on file", "exp") stay
    const parts = val.split(/(\s+)/);
    let keep = '';
    let i = 0;
    for (; i < parts.length; i++) {
      const tok = parts[i];
      if (/^\s+$/.test(tok)) { if (i + 1 < parts.length && /\d|^[Xx*•-]+$/.test(parts[i + 1])) { keep += tok; continue; } break; }
      if (/\d/.test(tok) || /^[Xx*•-]+$/.test(tok)) keep += tok; else break;
    }
    return `${label}${last4(keep)}${val.slice(keep.length)}`;
  });
}

/**
 * A person-ID paper (driver license, certification card, new-hire / HR form, insurance card) is masked harder, because OCR of a
 * card loses its labels: an identifier sits alone on a line ("D83475361", "CPR-596166", "99 850 622") and the birth date is just
 * the oldest date on the card. On those papers: every identifier-shaped run (a letter prefix + 5 or more digits, 7 or more digits,
 * or grouped digits) shows its last 4, and any date, month/year or year more than 14 years old is hidden as a probable birth date.
 * Business papers (invoices, quotes ...) keep their invoice / PO / job numbers.
 */
const ID_TOKEN_RE = /(?<![\w$.,/-])(?:[A-Za-z]{1,4}-?\d{5,}|\d{2,3}[ -]\d{2,3}[ -]\d{3,4}|\d{2}-\d{7}|\d{7,})(?![\w/-]|[.,]\d)/g;
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const NUM_DATE_RE = /(?<![\d])(\d{1,2})\s?([\/.-])\s?(\d{1,2})\s?\2\s?(\d{4}|\d{2})(?![\d])/g;
const ISO_DATE_RE = /(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;
const MONTH_YEAR_RE = /(?<![\d\/])(\d{1,2})\s?\/\s?(\d{4})(?![\d\/])/g;
const NAMED_DATE_RE = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+(\\d{4})|\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+(\\d{4}))\\b`, 'gi');
const BARE_YEAR_RE = /(?<![\d$.,\/-])(19\d{2}|20[01]\d)(?![\d\/-])/g;

function year2(y) { const n = Number(y); return y.length === 2 ? (n >= 40 ? 1900 + n : 2000 + n) : n; }

function maskIdPaper(t, today) {
  const oldest = today.getUTCFullYear() - 14; // a licence / card / certificate issued in the last 14 years is not a birth date
  const old = (yr) => yr <= oldest;
  t = t.replace(NUM_DATE_RE, (m, _a, _sep, _b, y) => (old(year2(y)) ? '[hidden]' : m));
  t = t.replace(ISO_DATE_RE, (m, y) => (old(Number(y)) ? '[hidden]' : m));
  t = t.replace(NAMED_DATE_RE, (m, y1, y2) => (old(Number(y1 ?? y2)) ? '[hidden]' : m));
  t = t.replace(MONTH_YEAR_RE, (m, _mo, y) => (old(Number(y)) ? '[hidden]' : m));
  t = t.replace(BARE_YEAR_RE, (m, y) => (old(Number(y)) ? '[hidden]' : m));
  t = t.replace(ID_TOKEN_RE, (m) => (PHONE_FORMATTED_RE.test(m) || /^\d{4}-\d{2}-\d{2}$/.test(m) ? m : last4(m)));
  return t;
}

/** @param {string} input @param {{id?: boolean, today?: Date}} [opts] id = the paper is a person-ID paper (see above) */
export function maskText(input, opts = {}) {
  let t = String(input ?? '');
  if (!t) return t;
  t = t.replace(DOB_RE, (_m, label) => `${label}[hidden]`);
  t = maskLabelled(t);
  t = t.replace(SSN_RE, (m) => last4(m));
  t = t.replace(CARD_RE, (m) => {
    const d = alnum(m);
    return d.length >= 13 && d.length <= 19 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? last4(m) : m;
  });
  t = t.replace(LONG_DIGITS_RE, (m) => ((opts.id ? false : PHONE_SHAPE_RE.test(m)) ? m : last4(m)));
  if (opts.id) t = maskIdPaper(t, opts.today ?? new Date());
  return t;
}

/** Mask a list of {page_no, text} pages. */
export const maskPages = (pages, opts = {}) => (pages ?? []).map((p) => ({ ...p, text: maskText(p.text, opts) }));
