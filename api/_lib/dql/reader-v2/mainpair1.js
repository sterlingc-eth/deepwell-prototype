/** mainpair1.js - port of lib/mainpair1.py (mainpair_v1): strip the document-name span ("X's <doc name> from <date>") before label matching. */
const ALL = ['fs_docname'];
let CFG = { on: false, rules: ALL };
export const configure = (d) => { CFG = { on: false, rules: ALL, ...(d || {}) }; };
export const enabled = (rule = null) => !!CFG.on && (rule === null || (CFG.rules || ALL).includes(rule));
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DOC = new RegExp("(['’]s\\s+)((?:[a-z][\\w-]*\\s+){1,4}?)(?=(?:from|dated|of)\\s+(?:\\d{1,2}[/.-]\\d|\\d{4}-\\d|" + MON + '\\b))', 'gi');
export const stripDocname = (q) => (enabled('fs_docname') ? q.replace(DOC, '$1') : q);
