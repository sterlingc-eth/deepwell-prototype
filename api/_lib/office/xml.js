/**
 * A small, strict, event-style XML reader for OOXML parts. Written here (no dependency) so every limit is ours:
 *   - ANY DOCTYPE / ENTITY / other `<!` declaration is refused: no entity expansion, no external DTD, no XXE, ever. The
 *     five predefined entities and bounded numeric references (&#N; &#xH;) are the only references decoded; any other
 *     `&name;` is refused as malformed. Nothing is fetched, nothing is resolved.
 *   - depth cap (MAX_XML_DEPTH) kept in a plain array, so a 100k-nested-tag file stops at depth 257, not at a stack overflow.
 *   - element/attribute name and attribute value length caps, attribute count cap.
 *   - tags must close in order; unclosed/mismatched/truncated markup is a clean refusal, not a partial read.
 *   - linear scanning with indexOf and char loops: no regular expression is run over file content (no backtracking bombs).
 *   - the clock is checked every 2048 tokens, so a huge part cannot outlive READ_TIMEOUT_MS between checks.
 * Namespaces: names are reduced to their local part ("w:p" -> "p", "r:id" -> "id"); xmlns declarations are dropped. OOXML
 * prefixes are conventional and a lying prefix can only change which text is picked up, never reach anything outside.
 */
import { MAX_XML_DEPTH } from "./limits.js";
import { OfficeError } from "./errors.js";

const MAX_NAME = 256;
const MAX_ATTRS = 256;
const MAX_ATTR_VALUE = 1 << 20; // 1 MiB: far above any legitimate attribute
const BAD = (what) => new OfficeError(422, "bad-xml",
  `This file's content is damaged or not valid (${what}). Re-save it from Word or Excel (or export it again) and upload again.`);

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;

/** Decode `s` (already known to contain '&') with only the predefined + bounded numeric references. */
export function decodeEntities(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const amp = s.indexOf("&", i);
    if (amp < 0) return out + s.slice(i);
    out += s.slice(i, amp);
    const semi = s.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 12) throw BAD("bad character reference");
    const ref = s.slice(amp + 1, semi);
    if (ref === "lt") out += "<";
    else if (ref === "gt") out += ">";
    else if (ref === "amp") out += "&";
    else if (ref === "quot") out += '"';
    else if (ref === "apos") out += "'";
    else if (ref.charCodeAt(0) === 35) {
      const hex = ref.charCodeAt(1) === 120;
      const digits = ref.slice(hex ? 2 : 1);
      if (!digits || !(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) throw BAD("bad character reference");
      const cp = parseInt(digits, hex ? 16 : 10);
      const ok = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd && cp !== 0xfffe) || (cp >= 0x10000 && cp <= 0x10ffff);
      if (!ok) throw BAD("illegal character reference");
      out += String.fromCodePoint(cp);
    } else {
      // An entity declared in a DTD (the only other kind) is exactly what we never expand.
      throw BAD("an undefined entity reference");
    }
    i = semi + 1;
  }
}

/** Bytes of an XML part -> string (UTF-8, or UTF-16 with a BOM). A leading BOM is dropped. */
export function xmlBytesToString(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; }
    return sw.toString("utf16le");
  }
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

const local = (q) => { const i = q.indexOf(":"); return i < 0 ? q : q.slice(i + 1); };

/**
 * Parse `xml` and call handlers. onOpen(name, attrs) / onClose(name) (a self-closing tag fires both) / onText(text).
 * `name` is the local name. attrs is a plain object keyed by local attribute name (null prototype).
 */
export function parseXml(xml, { onOpen, onClose, onText, clock } = {}) {
  const n = xml.length;
  const stack = [];
  let i = 0;
  let tokens = 0;
  let sawRoot = false;
  while (i < n) {
    if ((++tokens & 2047) === 0) clock?.check();
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      // trailing text after the root closed must be whitespace only
      const tail = xml.slice(i);
      if (stack.length || (sawRoot && tail.trim())) throw BAD("text outside the document");
      if (!sawRoot && tail.trim()) throw BAD("no document element");
      i = n;
      break;
    }
    if (lt > i) {
      if (!stack.length) {
        if (xml.slice(i, lt).trim()) throw BAD("text outside the document");
      } else if (onText) {
        const raw = xml.slice(i, lt);
        onText(raw.indexOf("&") >= 0 ? decodeEntities(raw) : raw);
      }
    }
    i = lt;
    const c1 = xml.charCodeAt(i + 1);
    if (c1 === 33) { // <!
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i + 4);
        if (end < 0) throw BAD("unclosed comment");
        i = end + 3;
      } else if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 9);
        if (end < 0 || !stack.length) throw BAD("unclosed CDATA section");
        if (onText) onText(xml.slice(i + 9, end));
        i = end + 3;
      } else {
        // <!DOCTYPE, <!ENTITY, <!ELEMENT ...: never read, never expanded.
        throw new OfficeError(422, "xml-dtd",
          "This file contains an unsafe XML declaration (DOCTYPE/ENTITY) that DeepWell never reads. Re-save it from Word or Excel and upload again.");
      }
      continue;
    }
    if (c1 === 63) { // <? ... ?>
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) throw BAD("unclosed declaration");
      i = end + 2;
      continue;
    }
    if (c1 === 47) { // </name>
      let j = i + 2;
      const s = j;
      while (j < n && isNameChar(xml.charCodeAt(j))) j++;
      const nameLen = j - s;
      if (nameLen > MAX_NAME || j === s) throw BAD("bad closing tag");
      while (j < n && isWs(xml.charCodeAt(j))) j++;
      if (xml.charCodeAt(j) !== 62) throw BAD("bad closing tag");
      const name = local(xml.slice(s, s + nameLen));
      if (!stack.length || stack[stack.length - 1] !== name) throw BAD("tags do not close in order");
      stack.pop();
      onClose?.(name);
      i = j + 1;
      continue;
    }
    // <name attr="v" ... > or />
    let j = i + 1;
    const ns = j;
    if (!isNameStart(xml.charCodeAt(j))) throw BAD("bad tag");
    while (j < n && isNameChar(xml.charCodeAt(j))) j++;
    if (j - ns > MAX_NAME) throw BAD("tag name too long");
    const name = local(xml.slice(ns, j));
    let attrs = null;
    let count = 0;
    let selfClose = false;
    for (;;) {
      while (j < n && isWs(xml.charCodeAt(j))) j++;
      if (j >= n) throw BAD("file cut off inside a tag");
      const c = xml.charCodeAt(j);
      if (c === 62) { j++; break; }
      if (c === 47) {
        if (xml.charCodeAt(j + 1) !== 62) throw BAD("bad tag");
        selfClose = true; j += 2; break;
      }
      if (!isNameStart(c)) throw BAD("bad attribute");
      const as = j;
      while (j < n && isNameChar(xml.charCodeAt(j))) j++;
      if (j - as > MAX_NAME) throw BAD("attribute name too long");
      const aq = xml.slice(as, j);
      while (j < n && isWs(xml.charCodeAt(j))) j++;
      if (xml.charCodeAt(j) !== 61) throw BAD("attribute without a value");
      j++;
      while (j < n && isWs(xml.charCodeAt(j))) j++;
      const quote = xml.charCodeAt(j);
      if (quote !== 34 && quote !== 39) throw BAD("attribute value not quoted");
      const vend = xml.indexOf(quote === 34 ? '"' : "'", j + 1);
      if (vend < 0) throw BAD("file cut off inside an attribute");
      if (vend - j - 1 > MAX_ATTR_VALUE) throw BAD("attribute value too long");
      if (++count > MAX_ATTRS) throw BAD("too many attributes");
      const rawv = xml.slice(j + 1, vend);
      if (rawv.indexOf("<") >= 0) throw BAD("bad attribute value");
      j = vend + 1;
      if (aq === "xmlns" || aq.startsWith("xmlns:")) continue;
      (attrs ??= Object.create(null))[local(aq)] = rawv.indexOf("&") >= 0 ? decodeEntities(rawv) : rawv;
    }
    if (!stack.length) {
      if (sawRoot) throw BAD("more than one document element");
      sawRoot = true;
    }
    if (stack.length >= MAX_XML_DEPTH) {
      throw new OfficeError(422, "xml-depth", "This file is nested too deeply to be a normal document. Re-save it from Word or Excel and upload again.");
    }
    onOpen?.(name, attrs ?? EMPTY);
    if (selfClose) onClose?.(name);
    else stack.push(name);
    i = j;
  }
  if (stack.length) throw BAD("the file is cut off (unclosed tags)");
  if (!sawRoot) throw BAD("no document element");
}
const EMPTY = Object.freeze(Object.create(null));
