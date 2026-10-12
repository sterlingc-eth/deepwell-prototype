/**
 * dql/translator/schema.js - the plan a small model is asked to write, and nothing else.
 *
 * The model writes a PLAN, never an answer. Every value in it is anchored to the question by a `words` field (the exact words as typed);
 * validate.js checks the plan against the question and the company's own vocabulary, turns it into a DQL plan (the same plan shape
 * dql/parse.js builds) and the DQL executor computes the answer over the company's records, so the figures, the names and the
 * source documents come from stored rows, never from the model.
 */
import { ENTITIES } from '../fields.js';

export const TP_OPS = Object.freeze(['count', 'count_distinct', 'list', 'sum', 'avg', 'median', 'min', 'max', 'group_count', 'group_sum', 'group_avg', 'top_n', 'bottom_n', 'latest', 'first_ever', 'exists_yes_no', 'share_pct', 'none']);
export const FILTER_OPS = Object.freeze(['eq', 'neq', 'in', 'notin', 'gt', 'gte', 'lt', 'lte', 'between', 'outside', 'missing', 'present']);
export const TIME_DIMS = Object.freeze(['year', 'month', 'quarter', 'monthOfYear', 'weekday']);
export const MEASURE_FIELDS = Object.freeze({ total: { label: 'total', unit: 'money' }, rent: { label: 'rent', unit: 'money' }, hours: { label: 'labor hours', unit: 'hours' }, tonnage: { label: 'tonnage', unit: 'tons' }, age: { label: 'age', unit: 'years' } });
/** the fields each kind of row can be asked about (generic ids; the company's own words for them come in the prompt) */
export const FIELD_MENU = Object.freeze({
  document: ['type', 'customer', 'tech', 'city', 'brand', 'model', 'serial', 'status', 'serviceType', 'vendor', 'refrigerant', 'tonnage', 'total', 'rent', 'hours', 'date', 'serviceDate', 'invoiceDate', 'createdAt', 'installDate'],
  customer: ['name', 'city', 'address', 'email', 'phone', 'docCount', 'unitCount', 'visitCount', 'billed', 'hasBrand'],
  unit: ['brand', 'model', 'serial', 'tonnage', 'refrigerant', 'equipmentType', 'customer', 'city', 'installDate', 'warrantyExpires', 'registeredDate', 'warrantyStatus', 'age', 'installYear'],
});
for (const e of Object.keys(FIELD_MENU)) for (const f of FIELD_MENU[e]) if (!ENTITIES[e].fields[f]) throw new Error(`translator schema: ${e}.${f} is not a DQL field`);

/** the tool the model must answer with (Anthropic tool_use input_schema) */
export const PLAN_TOOL = Object.freeze({
  name: 'plan',
  description: 'Report the query plan for the question. Use op "none" when the question cannot be expressed as a plan over the stored records.',
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: TP_OPS },
      reason: { type: 'string', description: 'only for op none: a few words on why' },
      entity: { type: 'string', enum: ['document', 'customer', 'unit'] },
      docType: { type: ['string', 'null'], description: 'one of the stored paper types listed below, or null' },
      visit: { type: ['boolean', 'null'], description: 'true when the question counts visits / appointments / service calls (papers that carry a service date) instead of one kind of paper' },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' }, op: { type: 'string', enum: FILTER_OPS }, value: {}, words: { type: 'string', description: 'the exact words of the question that state this condition' }, docType: { type: ['string', 'null'] },
          },
          required: ['field', 'op', 'words'],
        },
      },
      time: { type: ['object', 'null'], properties: { words: { type: 'string', description: 'the exact words of the question naming the period' }, field: { type: ['string', 'null'] } }, required: ['words'] },
      measure: { type: ['object', 'null'], properties: { field: { type: 'string' }, agg: { type: ['string', 'null'], enum: ['sum', 'avg', null] } }, required: ['field'] },
      groupBy: { type: 'array', items: { type: 'string' } },
      distinct: { type: ['string', 'null'] },
      sortField: { type: ['string', 'null'] },
      ask: { type: ['string', 'null'], enum: ['tech', 'customer', 'amount', null], description: 'only for latest / first_ever: the one fact of that paper the question asks for (who did it, which customer, how much)' },
      limit: { type: ['integer', 'null'] },
    },
    required: ['op'],
  },
});
