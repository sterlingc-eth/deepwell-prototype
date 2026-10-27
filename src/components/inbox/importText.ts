// Every customer-facing word of the bulk import autopilot (IMPORT_AUTOPILOT_REPORT.md lists them). PROPOSED wording, awaiting owner approval.
// No money, no model names, no cost anywhere here.
import { DOCUMENT_TYPES } from '../../domains/hvac/documentTypes';

const TYPE_LABELS = new Map<string, string>(DOCUMENT_TYPES.map((t) => [t.id, t.label]));
export const typeName = (id: string | null | undefined) => (id && TYPE_LABELS.get(id)) || 'Document';
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const num = (n: number) => n.toLocaleString('en-US');

export const IMPORT_TEXT = {
  progressTitle: (c: { total: number; filed: number; needYou: number; inProgress: number }) =>
    `Importing ${num(c.total)} documents: ${num(c.filed)} filed, ${num(c.needYou)} need you, ${num(c.inProgress)} in progress`,
  summaryTitle: 'Your import',
  summaryLine: (s: { filedAutomatically: number; decisions: number; lookAt: number }) =>
    `${num(s.filedAutomatically)} filed automatically · ${num(s.decisions)} ${plural(s.decisions, 'decision', 'decisions')} for you · ${num(s.lookAt)} ${plural(s.lookAt, 'paper', 'papers')} to look at`,
  allDone: 'Everything from this import is filed or set aside.',
  stillReading: 'Some papers are still being read. This page updates by itself.',
  decisionsHeading: 'Decisions for you',
  decisionsHelp: 'Each card is one cause shared by a group of papers. One press settles the whole group, and you can take it back.',
  showMore: (n: number) => `Show ${num(n)} more ${plural(n, 'decision', 'decisions')}`,
  showFewer: 'Show fewer decisions',
  samplesLabel: 'Three examples',
  moreInGroup: (n: number) => `and ${num(n)} more like these`,
  confirmTitle: (n: number) => `Apply to ${num(n)} ${plural(n, 'paper', 'papers')}?`,
  confirmBody: 'Every paper is checked again before anything changes. Any paper that no longer fits is left alone. You can undo this afterwards.',
  confirm: 'Yes, apply',
  cancel: 'Cancel',
  working: 'Working…',
  doneApplied: (n: number, skipped: number) => `Done: ${num(n)} ${plural(n, 'paper', 'papers')} changed` + (skipped ? `, ${num(skipped)} left for you to look at` : '') + '.',
  undo: 'Undo',
  undone: (n: number) => `Undone: ${num(n)} ${plural(n, 'paper', 'papers')} put back.`,
  undoneLeft: (n: number) => `${num(n)} ${plural(n, 'paper was', 'papers were')} changed by someone since, so ${plural(n, 'it was', 'they were')} left as is.`,
  error: "That didn't work. Try again in a minute; the list shows what is still open.",
  stoppedPart: (done: number, total: number) => `It stopped part way: ${num(done)} of ${num(total)} ${plural(total, 'paper', 'papers')} were changed and ${num(total - done)} were not. Undo puts the ${num(done)} back, or press the button again for the rest.`,
  gone: 'These papers changed while you were looking. The list has been refreshed.',
  kind: {
    'link-suggested': {
      title: (n: number, name: string) => `Link ${num(n)} ${plural(n, 'paper', 'papers')} to ${name}`,
      why: 'Each page names this customer clearly (name and address, or the exact name as the customer), and DeepWell already has them.',
      button: (n: number) => `Link all ${num(n)}`,
    },
    'create-customer': {
      title: (n: number, name: string) => `Add ${name} as a customer and link ${num(n)} ${plural(n, 'paper', 'papers')}`,
      why: 'The customer side of each page names them, and there is no customer by that name yet. Nothing is added until you press the button.',
      button: (n: number) => `Add customer and link ${num(n)}`,
    },
    'use-invoice-date': {
      title: (n: number) => `Use the invoice date for ${num(n)} ${plural(n, 'paper', 'papers')} with no service date`,
      why: 'These papers print an invoice date but no service date. The invoice date is saved as the service date, marked as yours.',
      button: (n: number) => `Use invoice date on ${num(n)}`,
    },
    'set-aside-copies': {
      title: (n: number) => `Set aside ${num(n)} ${plural(n, 'copy', 'copies')} of papers already filed`,
      why: 'Each of these matches a paper that is already filed. Setting aside keeps them out of your lists; nothing is deleted.',
      button: (n: number) => `Set aside ${num(n)}`,
    },
    'choose-type': {
      title: (n: number, a: string, b: string) => `${num(n)} ${plural(n, 'paper', 'papers')}: ${a} or ${b}?`,
      why: 'The file name says one thing and the page says another. Choose what they are.',
      button: (n: number, label: string) => `All ${num(n)} are ${label}`,
    },
    'file-passed': {
      title: (n: number) => `File ${num(n)} ${plural(n, 'paper', 'papers')} that passed every check`,
      why: 'Automatic filing is off, so these wait for one press.',
      button: (n: number) => `File ${num(n)}`,
    },
  },
  lookAtHeading: 'Papers to look at',
  lookAtHelp: 'These need a person, one at a time. Open them in your to-do list.',
  lookAtOpen: 'Open the list',
  reason: {
    'no-customer': 'No customer found',
    'which-customer': 'More than one customer could fit',
    'one-customer': 'One customer may fit: check it one at a time',
    'missing-info': 'Missing information',
    'hard-to-read': 'Hard to read',
    'unsure-value': 'A value to confirm',
    date: 'A date to confirm',
    type: 'Type to confirm',
    copy: 'May be a copy',
    money: 'Amounts to check',
    flag: 'A value to check',
    undone: 'You took this back',
    unreadable: 'Could not be read',
    other: 'Needs a look',
  } as Record<string, string>,
  settings: {
    label: 'File papers automatically when every check passes',
    help: 'Applies to big imports. A paper is filed only when it passes every automatic check. Filing never links a customer or changes a value; those only happen when you press a button.',
    save: 'Saved.',
    denied: 'Only an owner or admin can change this.',
    undoAll: 'Undo automatic filing for this import',
    undoAllConfirm: (n: number) => `Take ${num(n)} ${plural(n, 'paper', 'papers')} back out of Filed? Papers you have touched since are left alone.`,
    undoAllDone: (n: number) => `${num(n)} ${plural(n, 'paper', 'papers')} taken back out of Filed. Automatic filing is paused for this import.`,
    resume: 'Turn automatic filing back on for this import',
    paused: 'Automatic filing is paused for this import.',
  },
  toggleOn: 'On',
  toggleOff: 'Off',
  picker: 'Import',
  importOf: (total: number, date: string) => `${num(total)} documents, ${date}`,
} as const;
