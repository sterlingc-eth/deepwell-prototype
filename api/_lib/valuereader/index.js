/**
 * valuereader2 - generic deterministic no-model value reader (stricter-first) + operators for selection, multi-hop, compare and aggregate.
 * readValue(corpus, question, {k=5}) -> { ans, label, score, doc, page, detail?, sources? } when one verified result wins, else { ans: null, why } (abstain).
 * buildCorpus(pages): pages = [{ docId, file, page_no, text }].
 */
export { buildCorpus, retrieve, analyze } from "./vr_core.js";
export { readValue } from "./vr_ops.js";
