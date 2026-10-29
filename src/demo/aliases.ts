/** Alias map for /demo/?industry=<slug>. Keys are what links and people use (site page names, common trade names);
 *  values are demo industry slugs (the ones in fixtures/index.json). */
export const DEMO_ALIASES: Record<string, string> = {
  // industry-page filenames whose slug differs from the demo slug
  hvac: 'plumbing-hvac', plumbing: 'plumbing-hvac', 'plumbing-and-hvac': 'plumbing-hvac', heating: 'plumbing-hvac', 'heating-and-cooling': 'plumbing-hvac',
  plumber: 'plumbing-hvac', 'hvac-plumbing': 'plumbing-hvac',
  electric: 'electrical', electrician: 'electrical', electricians: 'electrical',
  contractors: 'general-contractor', contractor: 'general-contractor', construction: 'general-contractor', builder: 'general-contractor', builders: 'general-contractor',
  nonprofits: 'nonprofit', 'non-profit': 'nonprofit', 'non-profits': 'nonprofit', charity: 'nonprofit',
  offices: 'msp', office: 'msp', 'any-business': 'bookkeeping', any: 'bookkeeping', business: 'bookkeeping', other: 'bookkeeping', general: 'bookkeeping',
  'fleet-equipment-rental': 'auto', fleet: 'auto', 'equipment-rental': 'auto', 'fleet-and-equipment-rental': 'auto', rental: 'auto',
  // names people type
  propertymanagement: 'property-management', 'property-manager': 'property-management', landlord: 'property-management', rentals: 'property-management',
  'real-estate': 'realty', realestate: 'realty', realtor: 'realty', 'real-estate-agency': 'realty',
  law: 'legal', lawyer: 'legal', 'law-firm': 'legal', attorney: 'legal',
  accounting: 'bookkeeping', accountant: 'bookkeeping', cpa: 'bookkeeping',
  dental: 'dentaloffice', dentist: 'dentaloffice', 'dental-office': 'dentaloffice', 'dental-lab': 'dentallabco',
  medical: 'medicaloffice', doctor: 'medicaloffice', clinic: 'medicaloffice', 'medical-office': 'medicaloffice', 'medical-billing': 'medbillingco',
  vet: 'vetclinic', veterinary: 'vetclinic', 'vet-clinic': 'vetclinic', groomer: 'petgroomco', grooming: 'petgroomco',
  insurance: 'insagency', 'insurance-agency': 'insagency', it: 'msp', 'managed-services': 'msp', 'it-services': 'msp',
  roofer: 'roofing', lawn: 'landscaping', 'pest-control': 'pestcontrol', pool: 'poolservice', 'pool-service': 'poolservice', cleaners: 'cleaning',
  'auto-repair': 'auto', mechanic: 'auto', 'auto-shop': 'auto', trucks: 'trucking', logistics: 'trucking', freight: 'trucking',
  gym: 'gymfit', fitness: 'gymfit', salon: 'salonspa', spa: 'salonspa', daycare: 'daycarecenter', school: 'tutoring', tutor: 'tutoring',
  manufacturing: 'mfgqa', factory: 'mfgqa', 'feed-store': 'feedstore', farm: 'feedstore', 'food-truck': 'foodtruck', cafe: 'restaurant', bar: 'brewery',
  'event-venue': 'eventvenue', venue: 'eventvenue', wedding: 'weddingplan', 'wedding-planner': 'weddingplan', photographer: 'photostudio', photography: 'photostudio',
  film: 'filmprod', video: 'filmprod', grants: 'grantnp', 'grant-nonprofit': 'grantnp', police: 'policerecords', records: 'policerecords', municipal: 'policerecords', government: 'policerecords',
  hotels: 'hotel', motel: 'hotel', 'storage-units': 'storage', 'self-storage': 'storage', warehousing: 'warehouse', boat: 'marina', marinas: 'marina', churches: 'church',
};

/** Resolve a ?industry= value to a demo slug. Returns '' when it is empty or unknown (the caller shows the picker). */
export function resolveDemoSlug(want: string | null, known: readonly string[]): string {
  if (!want) return '';
  const k = want.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (known.includes(k)) return k;
  const a = DEMO_ALIASES[k] ?? DEMO_ALIASES[k.replace(/-/g, '')];
  return a && known.includes(a) ? a : '';
}
