-- 99-founder-testing-limits.sql — OPTIONAL, founder/test tenant only. Idempotent.
--
-- Lifts the per-day ask/ingest/read safety caps for the founder's test tenant
-- so live QA runs (question-bank samples, corpus re-ingest) are never cut off
-- by "Daily limit of N ask units reached". The per-minute cap (20/min) and
-- the monthly Donovan allowance are untouched. This is the ordinary
-- per-tenant override rateLimit.js already honours (limits.<bucket>.perDay);
-- run 24-tenant-limits-plan.sql first so every OTHER tenant gets its
-- plan-sized cap instead of Solo's.
--
-- To undo: UPDATE tenants SET limits = limits - 'ask' - 'ingest' - 'read' WHERE id = '9207877e-f712-4397-ac33-d3f0de467a66';

UPDATE tenants
   SET limits = COALESCE(limits, '{}'::jsonb)
             || '{"ask": {"perDay": 100000}, "ingest": {"perDay": 100000}, "read": {"perDay": 100000}}'::jsonb
 WHERE id = '9207877e-f712-4397-ac33-d3f0de467a66';

-- Proof (read-only): SELECT id, plan, limits FROM tenants WHERE id = '9207877e-f712-4397-ac33-d3f0de467a66';
