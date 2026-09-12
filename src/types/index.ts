// HVAC Domain Models (from DeepWell spec)

export interface Equipment {
  id: string;
  serialNumber: string;
  modelNumber: string;
  manufacturer: 'Carrier' | 'Lennox' | 'Rheem' | 'Trane' | 'York' | 'Other';
  equipmentType: 'AC' | 'Furnace' | 'Heat Pump' | 'Commercial Unit';
  installDate: Date;
  installedByTechId: string;
  installedByTechName: string;
  epaCertType?: 'Universal' | 'Type I' | 'Type II' | 'Type III';
  propertyId: string;
  warrantyExpiry: Date | null;
  warrantyType?: 'parts' | 'labor' | 'both' | 'compressor-only';
  partsExpiryDate?: Date;
  laborExpiryDate?: Date;
  compressorExpiryDate?: Date | null;
  status: 'active' | 'archived' | 'replaced';
  createdAt: Date;
  updatedAt: Date;
}

export interface Warranty {
  equipmentId: string;
  coverageType: 'parts' | 'labor' | 'both' | 'compressor-only';
  partsExpiryDate: Date;
  laborExpiryDate: Date;
  compressorExpiryDate: Date | null;
  terms: string;
}

export interface ServiceEvent {
  id: string;
  equipmentId: string;
  propertyId: string;
  technicianId: string;
  technicianName: string;
  workPerformed: string;
  cost: number;
  date: Date;
  notes: string;
  partsUsed?: string[];
}

export interface Property {
  id: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  customerId: string;
  customerName: string;
  equipment: Equipment[];
}

export interface Customer {
  id: string;
  name: string;
  type: 'residential' | 'commercial' | 'multi-family';
  properties: Property[];
  totalSpend: number;
  lastServiceDate: Date;
}

export interface Technician {
  id: string;
  name: string;
  email: string;
  phone: string;
  certifications: string[];
  specialty: string;
  yearsExperience: number;
  customersServed: number;
}
