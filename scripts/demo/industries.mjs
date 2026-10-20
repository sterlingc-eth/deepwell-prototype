// Demo-mode industry list. CORE = the first five, in picker order, each mapped to its industry pack and the pack variants to draw from.
// Every other pack becomes an industry with --all (slug = pack id, first variant).
export const CORE = [
  { slug: 'realty', label: 'Real estate', pack: 'realty', variants: ['brokerage'] },
  { slug: 'property-management', label: 'Property management', pack: 'property', variants: ['residential'] },
  { slug: 'plumbing-hvac', label: 'Plumbing & HVAC', pack: 'plumbing', variants: ['hvac', 'plumbing'] },
  { slug: 'electrical', label: 'Electrical', pack: 'electrical', variants: ['residential'] },
  { slug: 'general-contractor', label: 'General contractor', pack: 'construction', variants: ['residential'] },
];
export const LABELS = {
  auto: 'Auto repair', bookkeeping: 'Bookkeeping', brewery: 'Brewery', church: 'Church', cleaning: 'Cleaning & janitorial', daycarecenter: 'Daycare center',
  dentallabco: 'Dental lab', dentaloffice: 'Dental office', eventvenue: 'Event venue', feedstore: 'Feed & farm store', filmprod: 'Film production', foodtruck: 'Food truck',
  grantnp: 'Grant-funded nonprofit', gymfit: 'Gym & fitness', hotel: 'Hotel', insagency: 'Insurance agency', landscaping: 'Landscaping', legal: 'Law office', marina: 'Marina',
  medbillingco: 'Medical billing', medicaloffice: 'Medical office', mfgqa: 'Manufacturing', msp: 'IT services', nonprofit: 'Nonprofit', pestcontrol: 'Pest control',
  petgroomco: 'Pet grooming', photostudio: 'Photo studio', policerecords: 'Records office', poolservice: 'Pool service', realtybroker: 'Real estate brokerage', restaurant: 'Restaurant',
  roofing: 'Roofing', salonspa: 'Salon & spa', storage: 'Self storage', trucking: 'Trucking', tutoring: 'Tutoring', vetclinic: 'Veterinary clinic', warehouse: 'Warehouse', weddingplan: 'Wedding planning',
  plumbing: 'Plumbing', electrical: 'Electrical', property: 'Property management', construction: 'Construction',
};
export const FAMILY_LABELS = { trades_field_service: 'Trades & field service', property_hospitality: 'Property & hospitality', professional_office: 'Professional & office', health_personal_care: 'Health & personal care', food_goods_logistics: 'Food, goods & logistics', nonprofit_public_sector: 'Nonprofit & public sector' };
