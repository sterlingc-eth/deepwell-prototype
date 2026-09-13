# DeepWell: Lead Architect Brief (Sept 10, 2026)

## Role
Lead Solutions Architect for DeepWell — owns vision, architectural decisions, and execution. Standard: AWS-grade quality, 95%+ confidence, original thinking.

## The problem (corrected understanding)
HVAC contractors use ServiceTitan/Jobber/FieldEdge for dispatch, invoicing, scheduling, but their historical documents are a mess: scattered PDFs, photos, handwritten notes, old emails. Warranty claims and repeat-customer prep waste 30+ minutes hunting for proof. DeepWell is the intelligent document layer that ingests the chaos, extracts structure via AI, makes it searchable, and links it all together — a search + intelligence layer on top of existing systems, not a workflow replacement.

## Vision (north star)
Upload a photo of a 2-year-old work order → AI extracts serial, warranty dates, tech name, costs → auto-links to other documents for that equipment → "Show me all work on this customer's property" or "Is this warranty active?" returns full context in under 100ms.

## Architecture decided here
1. Document ingestion layer (drag-drop + mobile photo capture, bulk upload, progress/status).
2. AI extraction engine (MVP mock data, real LLM in Phase 2) — work orders, invoices, photos (OCR), confidence scoring (90%+ auto-approve / 80–89% flag / <80% manual), learning from corrections.
3. Entity linking — equipment as primary anchor (serial = unique id); graph: Equipment → Warranty → Service History → Technician → Customer → Property.
4. Search engine — natural language, fuzzy matching, multiple scopes, <100ms on mock data.
5. Manager dashboard — revenue, warranty, equipment (end-of-life $25K+ opportunities), tech performance, customer LTV/churn views.

## Data model (TypeScript sketch)
Equipment (serialNumber unique key, modelNumber, manufacturer, type, installDate, installedByTech, propertyId, status), Warranty (equipmentId, coverageType, expiryDates, terms), ServiceEvent (equipmentId, propertyId, technicianId, workPerformed, cost, date, linkedDocuments), Property (address, customerId, equipment[]), Customer (name, type, properties[], totalSpend, lastServiceDate), Document (filename, extractedData, confidence scores, linkedEntity, userApprovals).

## Quality standards (non-negotiable)
Search <100ms; extraction accuracy 95%+ on critical fields; WCAG AA 100%; bundle <200KB; TypeScript strict zero errors; premium, original design aesthetic (not generic SaaS).

## Success criteria for Sept 15 demo to Corey
Loads without console errors; 5 core screens functional; search <100ms on 15 scenarios; premium Navy+Copper design; mobile responsive (320/768/1920px); WCAG AA; Corey understands the value in 15 minutes.

## Execution plan (as of Sept 10)
Day 1–2: design system + foundation (colors, types, React/Router/Zustand/Vite setup, 5 core screens). Day 3–4: integration + polish (search wiring, animations, accessibility audit, bundle optimization). Day 5: rehearsal.

## Note on how this brief was superseded
This brief's navigation-hub architecture (5 screens, search-first) was replaced two days later by `claude/DEEPWELL_PRODUCT_REDESIGN_V2.md` (ingestion-first) and then by `claude/PRODUCT_DECISION_ASK_INTERFACE.md` (Ask-first, Sept 12) — kept here as the original north-star framing of the problem and quality bar, both of which remained binding even as the screen architecture changed.
