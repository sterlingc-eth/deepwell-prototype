// Canned API responses for scripts/verify-desktop-ux.mjs's customer-navigation check
// (CustomerProfileScreen/CustomersScreen read real endpoints even in demo mode — only
// DashboardScreen's own bonus cards gate on VITE_DEMO_MODE). Dev-only, never shipped.

export const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';

export const CUSTOMERS_LIST_RESPONSE = {
  customers: [
    {
      id: CUSTOMER_ID,
      customerNumber: 'C-00001',
      name: 'Harbor Point Apartments',
      serviceAddress: '5600 W Camelback Rd',
      city: 'Phoenix',
      phone: '555-0100',
      email: 'ops@harborpoint.example',
      documentCount: 6,
      equipmentCount: 2,
      lastActivity: '2026-09-01',
      warrantyAlerts: 1,
      alerts: { expiring: 1, expired: 0 },
      mergedInto: null,
    },
  ],
  duplicates: [],
  possibleDuplicates: [],
};

export const CUSTOMER_DETAIL_RESPONSE = {
  customer: {
    id: CUSTOMER_ID,
    customerNumber: 'C-00001',
    name: 'Harbor Point Apartments',
    serviceAddress: '5600 W Camelback Rd',
    phone: '555-0100',
    email: 'ops@harborpoint.example',
    notes: null,
    billingAddress: null,
    formerNumbers: [],
  },
  equipment: [
    {
      id: 'eq-1',
      serial: 'SN-LEN-345678',
      model: 'XC25',
      manufacturer: 'Lennox',
      installDate: '2022-09-14',
      warranty: { tier: 'expiring-90', expires: '2026-12-01', daysLeft: 60 },
    },
  ],
  documents: [
    { id: 'doc-1', filename: 'install-cert.pdf', displayName: null, type: 'install', stage: 'verified', verifiedBy: 'demo', createdAt: '2022-09-14', serviceDate: null, via: 'direct' },
  ],
  timeline: [
    { date: '2022-09-14', kind: 'install', title: 'Unit installed', documentId: 'doc-1' },
  ],
  duplicates: [],
  alertCount: 1,
};

export const REMINDERS_RESPONSE = { reminders: [] };
