// npm run verify:import-progress
// The live import progress panel, the "Check before importing" summary and the "Your documents are ready" notification:
// the pure pieces behind each, plus the wiring that lets the panel ask the server.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minutesLeft, formatTimeLeft } from '../src/core/importProgress.ts';
import { summarizePrecheck, kindLabels, formatBytes, kindOf } from '../src/core/importPrecheck.ts';
import { restoredPlace } from '../src/core/restorePlace.ts';
// @ts-expect-error plain JS module without types
import { shouldNotifyImportDone, importDoneMessage, IMPORT_NOTIFY_MIN } from '../api/_lib/importDone.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('verify:import-progress');

// ---- time left
eq('nothing left means 0 minutes', minutesLeft(0, 50), 0);
eq('no pace yet means no estimate', minutesLeft(100, 0), null);
eq('600 left at 60 per 10 minutes is 100 minutes', minutesLeft(600, 60), 100);
eq('rounds up', minutesLeft(7, 60), 2);
eq('under a minute', formatTimeLeft(1), 'less than a minute');
eq('minutes', formatTimeLeft(7), 'about 7 minutes');
eq('one hour', formatTimeLeft(61), 'about 1 hour');
eq('hours and minutes, to 10 minutes', formatTimeLeft(154), 'about 2 hours 30 minutes');

// ---- pre-check summary
const sum = summarizePrecheck(
  [
    { path: 'a/inv-1.pdf', sizeBytes: 1024 * 1024 },
    { path: 'a/IMG_2.HEIC', sizeBytes: 512 * 1024 },
    { path: 'Timesheet.xlsx', sizeBytes: 20 * 1024 },
    { path: 'notes.docx', sizeBytes: 30 * 1024 },
    { path: 'export.csv', sizeBytes: 10 * 1024 },
    { path: 'export2.csv', sizeBytes: 10 * 1024 },
  ],
  [{ skipReason: 'unsupported-type' }, { skipReason: 'dotfile' }, { skipReason: 'unsupported-type' }]
);
eq('counts every accepted file', sum.count, 6);
eq('counts by kind', sum.byKind, { pdf: 1, photo: 1, word: 1, excel: 1, text: 2 });
eq('skips grouped by reason', sum.skippedByReason, [{ reason: 'unsupported-type', count: 2 }, { reason: 'dotfile', count: 1 }]);
eq('kind labels, singular and plural', kindLabels(sum.byKind), ['1 PDF', '1 photo', '1 Word file', '1 Excel file', '2 text and CSV files']);
eq('size wording', [formatBytes(10 * 1024), formatBytes(5.5 * 1024 * 1024), formatBytes(2.2 * 1024 * 1024 * 1024)], ['10 KB', '5.5 MB', '2.2 GB']);
eq('unknown extension has no kind', kindOf('archive.rar'), null);

// ---- "Your documents are ready"
check('notifies when a bulk import has nothing left', shouldNotifyImportDone({ pending: 0, readRecent: IMPORT_NOTIFY_MIN, recentNotices: 0 }));
check('not while documents are still waiting', !shouldNotifyImportDone({ pending: 1, readRecent: 500, recentNotices: 0 }));
check('not for a small upload', !shouldNotifyImportDone({ pending: 0, readRecent: IMPORT_NOTIFY_MIN - 1, recentNotices: 0 }));
check('only once (cooldown)', !shouldNotifyImportDone({ pending: 0, readRecent: 500, recentNotices: 1 }));
const msg = importDoneMessage(1000);
eq('notification text', msg, {
  title: 'Your documents are ready',
  body: '1,000 documents were read and filed. Open the Inbox to see anything that needs you.',
  link: '/app/?screen=ingest',
});

// ---- refresh keeps your place
eq('Inbox comes back after a refresh', restoredPlace(JSON.stringify({ screen: 'ingest', inboxTab: 'needs-person' })), { screen: 'ingest', inboxTab: 'needs-person' });
eq('Dashboard comes back', restoredPlace(JSON.stringify({ screen: 'dashboard', inboxTab: 'add' })), { screen: 'dashboard', inboxTab: 'add' });
eq('an open customer comes back to Records', restoredPlace(JSON.stringify({ screen: 'customer' }))?.screen, 'browse');
eq('nothing saved means the default', restoredPlace(null), null);
eq('junk is ignored', [restoredPlace('not json'), restoredPlace(JSON.stringify({ screen: 'hack' }))], [null, null]);

// ---- wiring
const records = readFileSync(resolve(root, 'api/records.ts'), 'utf8');
check('importProgress is a read action open to every member', /RECORDS_READ_ACTIONS[\s\S]*?'importProgress'[\s\S]*?\]\);/.test(records) && records.includes("case 'importProgress'"));
const store = readFileSync(resolve(root, 'api/_lib/recordsStore.js'), 'utf8');
const q = store.slice(store.indexOf('importProgress: async'), store.indexOf('importProgress: async') + 1500);
check('importProgress query is tenant-scoped', q.includes('WHERE ${TENANT}'));
const queue = readFileSync(resolve(root, 'api/_lib/queue.js'), 'utf8');
check('queue checks for a finished import after each document', /extract-financials[\s\S]{0,300}notifyIfImportDone\(ctx\)/.test(queue));
const intake = readFileSync(resolve(root, 'src/screens/IntakeScreen.tsx'), 'utf8');
check('Inbox shows the live panel', intake.includes('<ImportProgressPanel />'));
check('long Inbox lists are capped', (intake.match(/slice\(0, LIST_ROW_LIMIT\)/g) || []).length === 2);
const bell = readFileSync(resolve(root, 'src/components/NotificationsPanel.tsx'), 'utf8');
check('read notifications leave the list', bell.includes('items.filter((i) => !i.readAt)') && bell.includes('visibleItems.map'));
check('bulk import waits for Start import', intake.includes('setPrecheck({') && !/walkZip\(files\[0\]\);\s*runBulkImport/.test(intake));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
