# Requests from agent-warranty

No blocking requests — everything needed (customer_name/service_address on
the equipment entity, `warranty` JSON on entities) already existed.

Non-blocking, for whoever owns product direction next:
- `api/_lib/warrantyRules.js`'s rule shape assumes registering always
  extends the PARTS term. Bosch's own certificate doesn't work that way (flat
  10yr parts regardless of registration; registering only adds a 90-day labor
  allowance) — it's left `rule: null` rather than forced into the wrong shape.
  A future "labor-only" rule variant would let Bosch (and possibly others) be
  modeled honestly. See docs/HVAC_WARRANTY_RESEARCH.md.
