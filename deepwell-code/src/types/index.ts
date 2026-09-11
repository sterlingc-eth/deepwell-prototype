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

export interface SearchResult {
  type: 'equipment' | 'service_event' | 'property';
  data: Equipment | ServiceEvent | Property;
  matchScore: number;
  confidence: number;
  matchReason: string;
}

export interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  selectedResult: SearchResult | null;
}

// Document Ingestion Types
export interface Document {
  id: string;
  filename: string;
  fileType: 'pdf' | 'image' | 'spreadsheet';
  fileSize: number;
  uploadedAt: Date;
  status: 'processing' | 'extracting' | 'review' | 'approved' | 'archived';
  s3Key?: string;
  extractionStatus?: 'pending' | 'in_progress' | 'complete' | 'failed';
}

export interface ExtractionField {
  fieldName: string;
  value: string;
  confidence: number; // 0-100
  source: string; // page number or location
  requiresReview: boolean;
}

export interface DocumentExtraction {
  id: string;
  documentId: string;
  extractedAt: Date;
  fields: ExtractionField[];
  overallConfidence: number;
  linkedEquipmentId?: string;
  linkedPropertyId?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  approvedAt?: Date;
  corrections?: Record<string, string>; // field_name -> corrected_value
}
