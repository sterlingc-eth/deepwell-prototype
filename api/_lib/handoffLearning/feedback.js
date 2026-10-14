/**
 * handoffLearning/feedback.js - step (d): expiry and rollback.
 *   retireOnFeedback(db, {question, rating})   a thumbs-down on a question the learnings could have changed retires every learning whose words are in it
 *   retireOnMismatch(db, engine, handoffs, agree)   a later handed-off question where the engine, using an active learning, answers differently from Claude retires that learning
 * Expired learnings (older than 90 days) stop being read on their own (store.listActive); the job re-confirms or lets them go.
 */
import { listLearnings, retireLearning } from './store.js';
import { buildOverlay } from './overlay.js';
import { handoffLearningEnabled } from './flag.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text, phrase) => new RegExp(`(?<![\\w'-])${esc(phrase).replace(/\s+/g, '\\s+')}(?![\\w-])`, 'i').test(text);

export async function retireOnFeedback(db, { question, rating, env = process.env } = {}) {
  if (!handoffLearningEnabled(env) || !/^(?:down|bad|negative|-1|thumbs-down)$/i.test(String(rating ?? ''))) return [];
  const hit = (await listLearnings(db, { status: 'active' })).filter((l) => has(String(question ?? ''), l.phrase));
  const out = [];
  for (const l of hit) if (await retireLearning(db, l.id, 'thumbs-down')) out.push(l.phrase);
  return out;
}

export async function retireOnMismatch(db, engine, handoffs, agree) {
  const active = (await listLearnings(db, { status: 'active' }));
  if (!active.length) return [];
  const out = [];
  for (const h of handoffs) {
    const used = active.filter((l) => has(h.question, l.phrase) && !out.includes(l.phrase));
    if (!used.length) continue;
    const ov = buildOverlay(used.map((l) => ({ kind: l.kind, phrase: l.phrase, canonical: l.canonical })));
    const a = engine.run(h.question, ov);
    if (a.ans && !agree(a.ans, h)) for (const l of used) if (await retireLearning(db, l.id, 'mismatch')) out.push(l.phrase);
  }
  return out;
}
