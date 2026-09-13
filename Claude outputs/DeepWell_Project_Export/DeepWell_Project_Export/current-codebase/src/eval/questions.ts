/**
 * The acceptance test for the answer service: 50 questions a dispatcher,
 * tech, or owner would actually ask, with what a correct answer must contain.
 * `npm run eval` runs them; `npm run eval -- --doc` regenerates
 * docs/EVAL_QUESTIONS.md from this file so the two never drift.
 *
 * Clock is fixed at 2026-09-12 so relative dates are deterministic.
 */
export interface EvalCase {
  id: number;
  group: string;
  q: string;
  /** Ask with "include unverified" on */
  includeUnverified?: boolean;
  expect: {
    kind: 'answer' | 'no-answer';
    entityId?: string;
    /** Every string must appear in the answer text (case-insensitive) */
    text?: string[];
    /** Every string must appear in some fact's label or value */
    facts?: string[];
    /** At least this many distinct verified documents cited */
    minVerified?: number;
    /** Exactly this many unverified documents held back */
    unverified?: number;
    /** Strings that must NOT appear in the answer text */
    notText?: string[];
  };
}

export const EVAL_NOW = new Date('2026-09-12T12:00:00');

export const EVAL_QUESTIONS: EvalCase[] = [
  // ---- Warranty status for an address ------------------------------------------------
  { id: 1, group: 'Warranty at an address', q: 'Is the furnace at 2847 N 24th St still under warranty?', expect: { kind: 'answer', entityId: 'PROP002', text: ['yes', 'nov 22, 2029'], facts: ['Active'], minVerified: 1 } },
  { id: 2, group: 'Warranty at an address', q: 'Is 1523 S Alma School Rd under warranty?', expect: { kind: 'answer', entityId: 'PROP003', text: ['2 units', '0 are still under warranty'], facts: ['Expired'] } },
  { id: 3, group: 'Warranty at an address', q: 'warranty status 6543 E Indian School', expect: { kind: 'answer', entityId: 'PROP010', text: ['yes', 'jul 19, 2028'] } },
  { id: 4, group: 'Warranty at an address', q: 'Is the Trane at 8765 W Thunderbird covered?', expect: { kind: 'answer', entityId: 'PROP004', text: ['no warranty on file'] } },
  { id: 5, group: 'Warranty at an address', q: 'Does 5600 W Camelback Rd have warranty coverage?', expect: { kind: 'answer', entityId: 'PROP006', text: ['no', 'sep 14, 2024'], facts: ['Expired'] } },
  { id: 6, group: 'Warranty at an address', q: 'Is the heat pump at 7890 N 16th St under warranty?', expect: { kind: 'answer', entityId: 'PROP007', text: ['yes', 'oct 30, 2027'] } },
  { id: 7, group: 'Warranty at an address', q: 'Is the furnace at 9012 W Van Buren still covered?', expect: { kind: 'answer', entityId: 'PROP009', text: ['2 units', '0 are still under warranty'] } },

  // ---- Serial lookup ------------------------------------------------------------------
  { id: 8, group: 'Serial lookup', q: 'SN-CAR-234567', expect: { kind: 'answer', entityId: 'EQ001', text: ['carrier ac', '4521 e camelback rd', 'expired'], facts: ['Serial', 'Model', 'Warranty'], minVerified: 2 } },
  { id: 9, group: 'Serial lookup', q: 'Serial SN-LEN-456789 — what is it and where is it?', expect: { kind: 'answer', entityId: 'EQ002', text: ['lennox furnace', '2847 n 24th st'] } },
  { id: 10, group: 'Serial lookup', q: 'sn-rhe-012345', expect: { kind: 'answer', entityId: 'EQ005', text: ['rheem heat pump', '3210 e broadway rd', 'maria santos'] } },
  { id: 11, group: 'Serial lookup', q: 'What is SNCAR789012?', expect: { kind: 'answer', entityId: 'EQ015', text: ['carrier ac', '6543 e indian school rd'] } },
  { id: 12, group: 'Serial lookup', q: 'Is SN-RHE-456789 under warranty?', expect: { kind: 'answer', entityId: 'EQ009', text: ['no', 'expired', 'aug 5, 2026'] } },
  { id: 13, group: 'Serial lookup', q: 'Who installed SN-TRA-789012?', expect: { kind: 'answer', entityId: 'EQ004', text: ['carlos rodriguez', 'jul 10, 2018'] } },
  { id: 14, group: 'Serial lookup', q: 'When was SN-LEN-567890 last serviced?', expect: { kind: 'answer', entityId: 'EQ010', text: ['jun 12, 2025', 'carlos rodriguez'], unverified: 1 } },
  { id: 15, group: 'Serial lookup', q: 'When was SN-LEN-567890 last serviced?', includeUnverified: true, expect: { kind: 'answer', entityId: 'EQ010', text: ['aug 8, 2026'], unverified: 0 } },
  { id: 16, group: 'Serial lookup', q: 'model XC21-100', expect: { kind: 'answer', entityId: 'EQ002', text: ['lennox furnace'] } },

  // ---- Technician's work at a customer / over a range --------------------------------
  { id: 17, group: "Technician's work", q: 'What did Carlos do at 4521 E Camelback in 2025?', expect: { kind: 'answer', entityId: 'TECH001', text: ['one visit', 'jun 12, 2025', '$210'] } },
  { id: 18, group: "Technician's work", q: 'What did David Chen do at Alma School last fall?', expect: { kind: 'no-answer', text: ['david chen has no recorded visits', 'last fall'] } },
  { id: 19, group: "Technician's work", q: 'What has Maria Santos done at 3210 E Broadway Rd?', expect: { kind: 'answer', entityId: 'TECH002', text: ['2 visits', '$495'] } },
  { id: 20, group: "Technician's work", q: 'What did Carlos Rodriguez do at 7890 N 16th St in 2025?', expect: { kind: 'answer', entityId: 'TECH001', text: ['2 visits', '$690'] } },
  { id: 21, group: "Technician's work", q: 'What did David Chen do at Van Buren this summer?', expect: { kind: 'no-answer', text: ['no recorded visits', 'include unverified'], unverified: 1 } },
  { id: 22, group: "Technician's work", q: 'What did David Chen do at Van Buren this summer?', includeUnverified: true, expect: { kind: 'answer', entityId: 'TECH003', text: ['jul 10, 2026', '$395'] } },
  { id: 23, group: "Technician's work", q: 'Did Maria work at the Johnson place?', expect: { kind: 'answer', entityId: 'TECH002', text: ['one visit', 'oct 8, 2024', '$425'] } },
  { id: 24, group: "Technician's work", q: 'What did Carlos Rodriguez do last year?', expect: { kind: 'answer', entityId: 'TECH001', text: ['4 recorded visits', 'last year'] } },
  { id: 25, group: "Technician's work", q: 'Show me everything David Chen has done', expect: { kind: 'answer', entityId: 'TECH003', text: ['recorded visits'], minVerified: 5 } },
  { id: 26, group: "Technician's work", q: 'Who serviced 4321 S Price Rd?', expect: { kind: 'answer', entityId: 'PROP008', text: ['maria santos', 'apr 15, 2025'] } },

  // ---- Expiring windows ----------------------------------------------------------------
  { id: 27, group: 'Expiring windows', q: 'Which units expire in the next 90 days?', expect: { kind: 'answer', text: ['no unit warranties expire in the next 90 days', 'may 8, 2027'] } },
  { id: 28, group: 'Expiring windows', q: 'Which warranties expire in the next 12 months?', expect: { kind: 'answer', text: ['1 unit expires in the next 12 months'], facts: ['May 8, 2027'], notText: ['Oct 30, 2027'] } },
  { id: 29, group: 'Expiring windows', q: 'Which Carrier units we installed expire in the next 2 years?', expect: { kind: 'answer', text: ['1 carrier unit expires'], facts: ['Jul 19, 2028'] } },
  { id: 30, group: 'Expiring windows', q: 'What warranties expired this year?', expect: { kind: 'answer', text: ['2 units went out of warranty this year'], facts: ['Feb 18, 2026', 'Aug 5, 2026'] } },
  { id: 31, group: 'Expiring windows', q: 'Which units are out of warranty?', expect: { kind: 'answer', text: ['7 units are out of warranty'] } },
  { id: 32, group: 'Expiring windows', q: 'Any Lennox warranties expiring soon?', expect: { kind: 'answer', text: ['no lennox unit warranties expire in the next 90 days', 'jan 12, 2028'] } },
  { id: 33, group: 'Expiring windows', q: 'Which heat pump warranties expire next year?', expect: { kind: 'answer', text: ['2 heat pumps expire'] } },

  // ---- Cost of a job -----------------------------------------------------------------
  { id: 34, group: 'Cost of a job', q: 'How much did the compressor replacement at Alma School cost?', expect: { kind: 'answer', entityId: 'PROP003', text: ['$1,850', 'nov 5, 2024'] } },
  { id: 35, group: 'Cost of a job', q: 'What did we charge for the install at 6543 E Indian School Rd?', expect: { kind: 'answer', entityId: 'PROP010', text: ['$2,200'] } },
  { id: 36, group: 'Cost of a job', q: 'How much has 7890 N 16th St spent with us?', expect: { kind: 'answer', entityId: 'PROP007', text: ['3 billed visits', '$925'] } },
  { id: 37, group: 'Cost of a job', q: 'What did the blower motor at Thunderbird cost?', expect: { kind: 'answer', entityId: 'PROP004', text: ['$550', 'dec 2, 2024'] } },
  { id: 38, group: 'Cost of a job', q: 'How much has service on SN-CAR-567890 cost?', expect: { kind: 'answer', entityId: 'EQ003', text: ['$2,005', '2 visits'] } },
  { id: 39, group: 'Cost of a job', q: 'How much did Office Plaza pay us in 2025?', expect: { kind: 'answer', entityId: 'PROP005', text: ['2 billed visits', '$705'] } },

  // ---- Last visit to an address -------------------------------------------------------
  { id: 40, group: 'Last visit', q: 'When were we last at 4321 S Price Rd?', expect: { kind: 'answer', entityId: 'PROP008', text: ['apr 15, 2025', 'maria santos'], unverified: 1 } },
  { id: 41, group: 'Last visit', q: 'When were we last at 4321 S Price Rd?', includeUnverified: true, expect: { kind: 'answer', entityId: 'PROP008', text: ['jun 10, 2026'], unverified: 0 } },
  { id: 42, group: 'Last visit', q: 'Last visit to 2847 N 24th St', expect: { kind: 'answer', entityId: 'PROP002', text: ['nov 20, 2025', 'carlos rodriguez', '$275'] } },
  { id: 43, group: 'Last visit', q: "When did we last service the Torres place?", expect: { kind: 'answer', entityId: 'PROP003', text: ['jan 10, 2026', 'david chen'] } },
  { id: 44, group: 'Last visit', q: 'most recent visit 5600 W Camelback Rd', expect: { kind: 'answer', entityId: 'PROP006', text: ['apr 15, 2026', 'condenser fan motor'] } },

  // ---- Bare entities: the full story ---------------------------------------------------
  { id: 45, group: 'Full story', q: '4521 E Camelback Rd', expect: { kind: 'answer', entityId: 'PROP001', text: ['james mitchell', '2 units', '1 under warranty', '3 service visits'], minVerified: 5, unverified: 1 } },
  { id: 46, group: 'Full story', q: 'James Mitchell', expect: { kind: 'answer', entityId: 'PROP001', text: ['4521 e camelback rd'] } },
  { id: 47, group: 'Full story', q: 'Commercial Warehouse Inc', expect: { kind: 'answer', entityId: 'PROP009', text: ['9012 w van buren st', '2 units'] } },
  { id: 48, group: 'Full story', q: 'How many Rheem units do we have?', expect: { kind: 'answer', text: ['3 rheem units'] } },

  // ---- Honest no-answer ---------------------------------------------------------------
  { id: 49, group: 'Honest no-answer', q: 'Is the boiler at 12 Main St under warranty?', expect: { kind: 'no-answer', text: ['nothing in your records answers that'] } },
  { id: 50, group: 'Honest no-answer', q: 'What is the capital of France?', expect: { kind: 'no-answer', text: ['nothing in your records'] } },
];
