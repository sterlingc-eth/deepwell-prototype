/**
 * R31 (Team A, loop 1) — conversational-frame stripping for the deterministic pre-router.
 *
 * WHY: 191 of the R26 exam's 197 "needs-model" questions are field-phrased variants of shapes the
 * deterministic layer ALREADY answers ("whats the phone number for X"), wrapped in spoken filler
 * ("so uh, ...", "quick one - ...", "hang on, ...", "gimme a sec, ...", "can you check, ...") and/or a
 * trailing tag ("... again", "... on file", "... whoever that is"). Every classifier's own regexes are
 * end-anchored on the bare shape, so one leading interjection sent a trivially answerable question to a
 * model. Fixing that per-classifier would re-implement the same stripping in six places; instead
 * classifyAll (router/classifyAll.js) retries the WHOLE pre-router once, on the stripped text, and only
 * adopts it when the raw text was not already claimed by a deterministic stage (never changes a
 * question that already routes today).
 *
 * Contract: PURE, no DB. Removes only words that carry NO information (interjections, hedges, polite
 * tags, "on file" as a suffix of a field noun); never a name, number, negation, comparison word,
 * quantifier ("show me"/"pull up"/"list"), or a wh-word. Returns null when nothing changed.
 */

const SEP = String.raw`[\s,;:.…–—-]*`;

// Leading noise, applied repeatedly (stacked: "hey um, quick one - ...").
const LEADING = [
  // Conversational lead-ins (v2 additions): "any chance you can tell me", "dispatch wants to know", "boss asked me,", "i forgot,", "ok last one:".
  new RegExp(String.raw`^(?:any\s+chance\s+(?:you\s+(?:can|could)\s+)?(?:tell\s+me\s+)?|dispatch\s+(?:wants|needs|is\s+asking)(?:\s+to\s+know)?|(?:the\s+)?boss\s+(?:asked|wants|needs)(?:\s+me)?(?:\s+to\s+know)?|i\s+forgot|(?:ok|okay)\s+last\s+one|last\s+one|hi\s+there|good\s+(?:morning|afternoon|evening)|wait|ah\s+right|mm+|erm|thing\s+is|question|sorry\s+to\s+bug\s+you|(?:one|two)\s+more\s+things?)\b${SEP}`, "i"),
  new RegExp(String.raw`^(?:so|uh+|um+|er+|hm+|ok(?:ay)?|well|hey|yo|hi|actually|alright|oh|anyway)\b${SEP}`, "i"),
  new RegExp(
    String.raw`^(?:quick(?:\s+(?:one|q|question|thing))?|real\s+quick|hang\s+on|hold\s+on|hold\s+up|one\s+(?:sec|second|moment)|gimme\s+a\s+(?:sec|second|minute|moment)|give\s+me\s+a\s+(?:sec|second|minute|moment)|just\s+a\s+(?:sec|second|moment)|lemme\s+(?:see|check)|let\s+me\s+see)\b${SEP}`,
    "i"
  ),
  // "can you check, whats ..." / "could you look up the ..." — the verb phrase is the frame; "if"/"whether"
  // are NOT stripped (they change a question into a statement: "can you check if X is under warranty").
  new RegExp(
    String.raw`^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:just\s+)?(?:quickly\s+)?(?:check|look\s+up|look\s+for|tell\s+me|find(?:\s+out)?|get\s+me|give\s+me|pull(?:\s+up)?|grab|see)(?!\s+(?:if|whether)\b)\b${SEP}`,
    "i"
  ),
  new RegExp(String.raw`^(?:can|could)\s+(?:i|we)\s+(?:please\s+)?(?:just\s+)?(?:get|have|see)\s+(?:the\s+)?`, "i"),
  new RegExp(String.raw`^(?:please|pls)\b${SEP}`, "i"),
  // Situational lead-ins: "sorry, one more -", "im in the truck,", "customer is on the line,".
  new RegExp(String.raw`^(?:sorry|excuse\s+me|pardon(?:\s+me)?)\b${SEP}(?:one\s+more(?:\s+(?:thing|question))?\b${SEP})?`, "i"),
  new RegExp(String.raw`^one\s+more(?:\s+(?:thing|question))?\b${SEP}`, "i"),
  new RegExp(String.raw`^i'?m\s+(?:in\s+the\s+(?:truck|van|attic)|on\s+(?:site|the\s+(?:road|roof|job))|at\s+the\s+(?:shop|office|job(?:\s*site)?)|out\s+(?:here|in\s+the\s+field)|here)\b${SEP}`, "i"),
  new RegExp(String.raw`^(?:the\s+)?customer(?:'?s|\s+is)\s+(?:on\s+the\s+(?:line|phone)|here|waiting|asking)\b${SEP}`, "i"),
];

// Trailing noise, applied repeatedly.
const TRAILING = new RegExp(
  String.raw`${SEP}(?:again|please|pls|thanks?|thx|for\s+me|right\s+now|real\s+quick|whoever\s+(?:that|it)\s+is|thx|cheers|lol|sir|buddy|mate|whenever|today|ok\??|okay\??|if\s+that'?s\s+ok|for\s+the\s+file|or\s+something|or\s+whatever|i\s+think|if\s+(?:you|we)\s+(?:can|have|got|know)(?:\s+(?:it|that|one|them))?|if\s+possible|if\s+you\s+don'?t\s+mind|when\s+you\s+can|when\s+you\s+get\s+a\s+(?:chance|sec|minute)|asap)${SEP}$`,
  "i"
);

// "...phone number, the one on file" / "...phone on file" / "...address we have on file": "on file" as a
// suffix of a field noun is a no-op tag (the contact shapes are end-anchored on the field word).
const ON_FILE_SUFFIX = new RegExp(
  String.raw`(\b(?:phone(?:\s+number)?|number|e-?mail|(?:service\s+)?address|serial(?:\s+number)?|model(?:\s+number)?|contact(?:\s+number)?|warranty(?:\s+status)?))${SEP}(?:the\s+one\s+)?(?:that\s+)?(?:we\s+(?:have|got)\s+)?on\s+file${SEP}$`,
  "i"
);

// "where's <name>'s unit (located)" -> the unit's service address. Name capture is 1-4 name-ish tokens.
const WHERE_UNIT = /^where(?:'?s|\s+is)\s+((?:[A-Za-z][A-Za-z.'-]*\s+){0,3}[A-Za-z][A-Za-z.-]*)['’]s?\s+(?:unit|system|equipment)(?:\s+(?:located|at|installed|is|sits|stationed))?\s*\??$/i;

// Closed paraphrase table: synonyms for a FIELD or a REQUEST verb rewritten to the wording the deterministic
// shapes are written against. Each rule is meaning-preserving on its own (no entity is ever added/removed).
const CANON = [
  // nlNormalize's fuzzy corrector turns "contact" into "contract" (edit distance 1) before any shape sees it.
  [/\bcontact\s+(?:number|phone(?:\s+number)?)\b/gi, "phone number"],
  [/\b(?:cell(?:\s*phone)?|mobile)(?:\s+(?:number|phone))?\b/gi, "phone"],
  [/\be-?mail\s+address\b/gi, "email"],
  // "how do I reach <name>" / "what number do I call for <name>" -> a phone-number request.
  [/^how\s+(?:do|can|could|would)\s+(?:i|we)\s+(?:reach|contact|call|get\s+(?:a\s+)?hold\s+of|get\s+in\s+touch\s+with)\s+(.+)$/i, "phone number for $1"],
  [/^what(?:'?s|\s+is)?\s+(?:the\s+)?(?:best\s+)?number\s+(?:do\s+(?:i|we)\s+)?(?:call|dial|use)\s+for\s+(.+)$/i, "phone number for $1"],
  // "<name> unit serial" / "<name>'s system model number" -> "<field> number for <name>'s unit"
  [/^((?!(?:what|whats|who|whos|which|is|does|do|how|the|a|an)\b)[a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,3}?)(?:'s)?\s+(?:unit|system)\s+(serial|model)(?:\s+number)?$/i, "$2 number for $1's unit"],
];

/** @returns {string|null} the stripped text, or null when there was nothing to strip. */
export function stripConversationalFrame(question) {
  const original = String(question ?? "").trim();
  if (!original) return null;
  let q = original.replace(/[‘’]/g, "'");
  for (let i = 0; i < 8; i++) {
    let next = q;
    for (const re of LEADING) next = next.replace(re, "").trim();
    if (next === q) break;
    q = next;
  }
  for (let i = 0; i < 4; i++) {
    let next = q.replace(TRAILING, "").trim();
    next = next.replace(ON_FILE_SUFFIX, "$1").trim();
    if (next === q) break;
    q = next;
  }
  for (const [re, to] of CANON) q = q.replace(re, to);
  const w = q.match(WHERE_UNIT);
  if (w) q = `whats the service address for ${w[1]}`;
  // A stripped remainder too short to be a question (<2 words) is not a usable frame removal.
  if (q.split(/\s+/).filter(Boolean).length < 2) return null;
  return q === original.replace(/[‘’]/g, "'") ? null : q;
}
