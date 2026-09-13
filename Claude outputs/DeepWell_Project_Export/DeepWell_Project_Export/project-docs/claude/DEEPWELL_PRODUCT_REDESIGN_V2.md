# DeepWell Product Redesign - Phase 2 Architecture
**Date: September 10, 2026**

## Critical Realization

The initial prototype was fundamentally wrong. It was a mock-data search interface, not an AI document ingestion platform. DeepWell is an AI company that solves HVAC contractors' document chaos problem.

## New Core Flow

### 1. Document Ingestion (Primary Entry Point)
- **Users upload**: photos, PDFs, spreadsheets
- **Drag-drop interface** with upload progress
- **Mock AI extraction** shows what will be extracted
- **Files stored** (mock S3 for demo, real S3 in production)

### 2. Extraction Review & Approval
- **AI-extracted fields** displayed with confidence scoring:
  - 90%+ → auto-approve eligible
  - 85-89% → review recommended
  - <85% → manual review required
- **User can edit** any extracted field
- **Confidence visualization** with color-coded bars
- **Progress tracking** across multiple documents

### 3. Equipment Linking
- Extracted serial numbers → auto-link to existing equipment
- Same equipment across 10+ documents gets linked graph
- One document links to full history (warranty, service events, etc.)

### 4. Search & Intelligence
- Query by address, serial, customer, technician, date
- Results show **full linked context**
- Equipment card displays: warranty status, service history, technical details
- All sourced from extracted + linked documents

### 5. Dashboard & Alerts
- Overview: documents ingested, equipment linked, warranties expiring
- **At-Risk Equipment** section: warranty expiration alerts
- Quick actions: upload, search, warranty prep

## Screens Built (V2)

### 1. `DocumentIngestionScreen.tsx` ✓
- Drag-drop upload area
- File list with progress indicators
- Tips section for best practices
- Button to review extractions

### 2. `ExtractionReviewScreen.tsx` ✓
- Document-by-document review flow
- Extracted fields with confidence %
- Edit fields inline
- Approve/reject/next workflow
- Progress bar across all documents

### 3. `DashboardScreen.tsx` ✓
- 4-stat overview (documents, equipment linked, warranty alerts, accuracy)
- Recent documents list
- Equipment at risk section
- Quick action buttons

### 4. Updated `OnSiteSearchScreen.tsx`
- Positioned as secondary (not primary) feature
- Search over extracted equipment data
- Results link back to source documents

### 5. Repurposed Screens
- `JobDispatchBriefScreen` → Equipment detail view
- `WarrantyExportScreen` → Warranty claim prep from extracted data

## Data Model Added

```typescript
interface Document {
  id: string;
  filename: string;
  fileType: 'pdf' | 'image' | 'spreadsheet';
  uploadedAt: Date;
  status: 'processing' | 'extracting' | 'review' | 'approved' | 'archived';
}

interface ExtractionField {
  fieldName: string;
  value: string;
  confidence: number; // 0-100
  source: string; // location in document
  requiresReview: boolean;
}

interface DocumentExtraction {
  id: string;
  documentId: string;
  fields: ExtractionField[];
  linkedEquipmentId?: string;
  approvedAt?: Date;
  corrections?: Record<string, string>;
}
```

## App State Updated

Added screen types:
- `'home'` → DocumentIngestionScreen (primary)
- `'dashboard'` → Dashboard overview
- `'extraction-review'` → Extraction approval flow
- `'search'` → Secondary: search equipment
- `'dispatch-brief'` → Equipment detail
- `'warranty-export'` → Warranty claim prep

## Quality Metrics Met

- ✓ TypeScript strict mode (zero type errors)
- ✓ Framer Motion animations (purposeful, <300ms)
- ✓ Design system: Navy (#1a3a5c) + Copper (#c4622d)
- ✓ Responsive (tested wireframe approach)
- ✓ Mock data confidence scoring (simulated AI)
- ✓ Bundle size warning noted (optimize with code-splitting next)

## What's Next (Phase 3)

1. **Real AI Integration**
   - Replace mock confidence % with actual LLM extraction (Claude API)
   - OCR integration for PDFs/images
   - Spreadsheet parsing for Excel/CSV

2. **Backend Integration**
   - AWS S3 for document storage
   - PostgreSQL for extraction data
   - Vector DB (Weaviate) for semantic search

3. **Entity Resolution**
   - Auto-link documents by equipment serial
   - Fuzzy matching for OCR errors
   - Conflict resolution UI

4. **Workflow Enhancements**
   - Bulk upload with batch processing
   - Warranty auto-extraction calendar
   - Technician performance analytics

5. **Production Readiness**
   - WCAG AA accessibility audit
   - Bundle optimization (<200KB gzipped)
   - Performance testing (<100ms search)

## Status
- [x] Architecture redesign complete
- [x] 3 new screens built (Ingestion, Review, Dashboard)
- [x] Type definitions updated
- [x] App state updated
- [x] Build successful
- [ ] Visual testing (dev server)
- [ ] Corey demo prep (Sept 15)
