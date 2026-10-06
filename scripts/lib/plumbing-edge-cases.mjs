/**
 * Plumbing edge-case additions (review round): extra documents and truth for the day-boundary rules, kept apart from the
 * tester's fixtures (plumbing-fixtures.mjs / plumbing-questions.mjs are not edited). Truth is worked out from the specs here, never from the lane.
 *   - backflow: due exactly in 60 days is in the window, 61 is not; due today is not overdue; yesterday is overdue
 *   - a failed test dated in the future never gives negative days; an unrecognised result is never invisible
 *   - permits: expiring today is open and expiring (not expired); +60 in, +61 out
 *   - warranties: expiring today is still under warranty; yesterday is expired; +60 in, +61 out
 */
import { TODAY, addDays, long } from './plumbing-fixtures.mjs';

const bf = (n, addr, cust, serial, test, result, due) => `BACKFLOW TEST CERTIFICATE\nService Address: ${addr}, Mesa AZ\nCustomer: ${cust}\nDevice Type: RPZ\nManufacturer: Watts\nModel: 909\nSerial Number: ${serial}\nSize: 1 inch\nDevice Location: Front yard\nTester Name: Edge Tester\nTester Cert No: AZ-BF-9${n}\nTest Date: ${long(test)}\nResult: ${result}\n${due ? `Next Test Due: ${long(due)}\n` : ''}`;
const pm = (no, addr, cust, expires) => `PLUMBING PERMIT\nPermit No: ${no}\nService Address: ${addr}, Mesa AZ\nCustomer: ${cust}\nJurisdiction: City of Mesa\nIssued: ${long(addDays(TODAY, -120))}\nExpires: ${long(expires)}\nStatus: Open\n`;
const wr = (addr, cust, serial, exp) => `WARRANTY REGISTRATION\nService Address: ${addr}, Mesa AZ\nCustomer: ${cust}\nManufacturer: Rheem\nModel: PROG50\nSerial Number: ${serial}\nDate Registered: ${long(addDays(TODAY, -900))}\nWarranty Term: 6 years\nWarranty Expires: ${long(exp)}\n`;

export const EDGE = {
  docs: [
    { filename: 'edge-bf-60.pdf', type: 'backflow-test-certificate', text: bf(1, '7001 Edge Way', 'Edge Alpha', 'EDG-60', addDays(TODAY, -305), 'Passed', addDays(TODAY, 60)) },
    { filename: 'edge-bf-61.pdf', type: 'backflow-test-certificate', text: bf(2, '7002 Edge Way', 'Edge Bravo', 'EDG-61', addDays(TODAY, -304), 'Passed', addDays(TODAY, 61)) },
    { filename: 'edge-bf-0.pdf', type: 'backflow-test-certificate', text: bf(3, '7003 Edge Way', 'Edge Charlie', 'EDG-00', addDays(TODAY, -365), 'Passed', TODAY) },
    { filename: 'edge-bf-m1.pdf', type: 'backflow-test-certificate', text: bf(4, '7004 Edge Way', 'Edge Delta', 'EDG-M1', addDays(TODAY, -366), 'Passed', addDays(TODAY, -1)) },
    { filename: 'edge-bf-future-fail.pdf', type: 'backflow-test-certificate', text: bf(5, '7005 Edge Way', 'Edge Echo', 'EDG-FF', addDays(TODAY, 20), 'Failed', null) },
    { filename: 'edge-pm-today.pdf', type: 'permit', text: pm('PL-EDGE-1', '7011 Edge Way', 'Edge Golf', TODAY) },
    { filename: 'edge-pm-60.pdf', type: 'permit', text: pm('PL-EDGE-2', '7012 Edge Way', 'Edge Hotel', addDays(TODAY, 60)) },
    { filename: 'edge-pm-61.pdf', type: 'permit', text: pm('PL-EDGE-3', '7013 Edge Way', 'Edge India', addDays(TODAY, 61)) },
    { filename: 'edge-wr-today.pdf', type: 'warranty-registration', text: wr('7021 Edge Way', 'Edge Juliet', 'EDG-W0', TODAY) },
    { filename: 'edge-wr-m1.pdf', type: 'warranty-registration', text: wr('7022 Edge Way', 'Edge Kilo', 'EDG-W1', addDays(TODAY, -1)) },
    { filename: 'edge-wr-60.pdf', type: 'warranty-registration', text: wr('7023 Edge Way', 'Edge Lima', 'EDG-W2', addDays(TODAY, 60)) },
    { filename: 'edge-wr-61.pdf', type: 'warranty-registration', text: wr('7024 Edge Way', 'Edge Mike', 'EDG-W3', addDays(TODAY, 61)) },
  ],
  /** Rows the extractor rightly refuses (an unrecognised result goes to the model), stored directly to prove the lane never hides them. */
  direct: [{ filename: 'edge-bf-unreadable.pdf', type: 'backflow-test-certificate', fields: { service_address: '7006 Edge Way, Mesa AZ', customer_name: 'Edge Foxtrot', serial_number: 'EDG-UN', device_size: '1 inch', service_date: addDays(TODAY, -100), backflow_test_result: 'Hold for review' } }],
  streets: { bf60: '7001 Edge Way', bf61: '7002 Edge Way', bf0: '7003 Edge Way', bfm1: '7004 Edge Way', bfff: '7005 Edge Way', bfun: '7006 Edge Way', pmToday: '7011 Edge Way', pm60: '7012 Edge Way', pm61: '7013 Edge Way', w0: '7021 Edge Way', wm1: '7022 Edge Way', w60: '7023 Edge Way', w61: '7024 Edge Way' },
};
