/** tokenizer.js - BERT uncased WordPiece (MiniLM-L6-H384-uncased vocab) with the same output as the Hugging Face fast tokenizer for the texts Donovan feeds it. */
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || /^\p{Zs}$/u.test(c);
const isCtl = (c) => { if (c === '\t' || c === '\n' || c === '\r') return false; return /^[\p{Cc}\p{Cf}]$/u.test(c); };
const isPunct = (c) => { const cp = c.codePointAt(0); if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true; return /^\p{P}$/u.test(c); };
const isCjk = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
export class WordPiece {
  constructor(vocabText) {
    this.vocab = new Map(); vocabText.split('\n').forEach((w, i) => { if (w !== '' || i < 30522) this.vocab.set(w.replace(/\r$/, ''), i); });
    this.unk = this.vocab.get('[UNK]'); this.cls = this.vocab.get('[CLS]'); this.sep = this.vocab.get('[SEP]'); this.cache = new Map();
  }
  basic(text) {
    let out = '';
    for (const ch of text) { const cp = ch.codePointAt(0); if (cp === 0 || cp === 0xfffd || isCtl(ch)) continue; out += isWs(ch) ? ' ' : ch; }
    let sp = ''; for (const ch of out) sp += isCjk(ch.codePointAt(0)) ? ` ${ch} ` : ch;
    sp = sp.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
    const toks = []; for (const w of sp.split(/ +/)) { if (!w) continue; let cur = ''; for (const ch of w) { if (isPunct(ch)) { if (cur) toks.push(cur); toks.push(ch); cur = ''; } else cur += ch; } if (cur) toks.push(cur); }
    return toks;
  }
  wordpiece(w) {
    const c = this.cache.get(w); if (c) return c;
    const ch = [...w]; let res;
    if (ch.length > 100) res = [this.unk];
    else {
      const ids = []; let start = 0; let bad = false;
      while (start < ch.length) {
        let end = ch.length, cur = null;
        while (start < end) { let sub = ch.slice(start, end).join(''); if (start > 0) sub = '##' + sub; if (this.vocab.has(sub)) { cur = this.vocab.get(sub); break; } end--; }
        if (cur === null) { bad = true; break; }
        ids.push(cur); start = end;
      }
      res = bad ? [this.unk] : ids;
    }
    this.cache.set(w, res); return res;
  }
  tokens(text) { const ids = []; for (const w of this.basic(text)) for (const i of this.wordpiece(w)) ids.push(i); return ids; }
  /** single text: [CLS] ... [SEP], truncated to maxLen */
  encode(text, maxLen) { let t = this.tokens(text); if (t.length > maxLen - 2) t = t.slice(0, maxLen - 2); return { ids: [this.cls, ...t, this.sep], types: new Array(t.length + 2).fill(0) }; }
  /** pair, truncation='only_second' */
  encodePair(a, b, maxLen) {
    const ta = this.tokens(a); let tb = this.tokens(b);
    const room = maxLen - ta.length - 3;
    if (room < 0) throw new Error('first sequence too long');
    if (tb.length > room) tb = tb.slice(0, room);
    return { ids: [this.cls, ...ta, this.sep, ...tb, this.sep], types: [0, ...ta.map(() => 0), 0, ...tb.map(() => 1), 1] };
  }
}
