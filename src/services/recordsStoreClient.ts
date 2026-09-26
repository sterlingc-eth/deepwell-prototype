/**
 * Browser client for RecordsStore API
 * Calls Vercel Functions API instead of IndexedDB
 */

import type {
  RecordsStore,
  Document,
  DocumentFilters,
  Facet,
  Extraction,
  Entity,
  Proposal,
  AuditAction,
  AuditFilters,
} from '../services/postgresRecordsStore';

import { authHeader } from './authToken';
import type { BrowseFilters, BrowseResponse } from '../components/records/types';

const API_URL = '/api/records';

export class RecordsStoreClient implements RecordsStore {
  /** Kept for the RecordsStore interface; the server derives the real tenant
   *  from the verified token, so this is no longer sent with requests. */
  tenantId: string = '';
  private headers = { 'Content-Type': 'application/json' };

  async connect(tenantId: string): Promise<void> {
    this.tenantId = tenantId;
  }

  async disconnect(): Promise<void> {
    this.tenantId = '';
  }

  private async call(action: string, payload: any = {}) {
    const response = await fetch(API_URL, {
      method: 'POST',
      // The server derives the tenant from the verified token; sending one from
      // here would be ignored, so we no longer send it.
      headers: { ...this.headers, ...(await authHeader()) },
      body: JSON.stringify({ action, ...payload }),
    });

    if (!response.ok) {
      // A 500 from Vercel is an HTML error page, so .json() would throw a
      // SyntaxError and hide the real status. Read as text and try to parse.
      const raw = await response.text().catch(() => '');
      let message = `API error ${response.status}: ${response.statusText}`;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.error) message = parsed.error;
      } catch {
        /* not JSON — keep the status-based message */
      }
      throw new Error(message);
    }

    return response.json();
  }

  // Documents
  async createDocument(doc: Document): Promise<string> {
    const result = await this.call('createDocument', doc);
    return result.id;
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.call('getDocument', { id });
  }

  async listDocuments(filters?: DocumentFilters): Promise<Document[]> {
    return this.call('listDocuments', { filters });
  }

  async updateDocument(id: string, updates: Partial<Document>): Promise<void> {
    await this.call('updateDocument', { id, updates });
  }

  /** Records Browse (round 12 contract): the paginated/filtered/faceted list
   *  behind the records screen — see api/_lib/recordsStore.js's
   *  browseDocuments for the server side. Never capped at 500: pass the
   *  previous response's `nextCursor` back in `filters.cursor` for the next
   *  page. */
  async browseDocuments(filters: BrowseFilters): Promise<BrowseResponse> {
    return this.call('browseDocuments', { filters });
  }

  // Facets
  async createFacet(facet: Facet): Promise<string> {
    const result = await this.call('createFacet', facet);
    return result.id;
  }

  async getFacet(id: string): Promise<Facet | null> {
    return this.call('getFacet', { id });
  }

  async listFacetsByDocument(documentId: string): Promise<Facet[]> {
    return this.call('listFacetsByDocument', { documentId });
  }

  async updateFacet(id: string, updates: Partial<Facet>): Promise<void> {
    await this.call('updateFacet', { id, updates });
  }

  // Extractions
  async createExtraction(extraction: Extraction): Promise<string> {
    const result = await this.call('createExtraction', extraction);
    return result.id;
  }

  async getExtraction(id: string): Promise<Extraction | null> {
    return this.call('getExtraction', { id });
  }

  async listExtractionsByDocument(documentId: string): Promise<Extraction[]> {
    return this.call('listExtractionsByDocument', { documentId });
  }

  /** All extractions for many documents in one round trip. See usePostgresSync. */
  async listExtractionsByDocuments(documentIds: string[]): Promise<Extraction[]> {
    return this.call('listExtractionsByDocuments', { documentIds });
  }

  async listExtractionsByEntity(entityId: string): Promise<Extraction[]> {
    return this.call('listExtractionsByEntity', { entityId });
  }

  async updateExtraction(id: string, updates: Partial<Extraction>): Promise<void> {
    await this.call('updateExtraction', { id, updates });
  }

  // Entities
  async createEntity(entity: Entity): Promise<string> {
    const result = await this.call('createEntity', entity);
    return result.id;
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.call('getEntity', { id });
  }

  async listEntities(type?: string): Promise<Entity[]> {
    return this.call('listEntities', { type });
  }

  async updateEntity(id: string, updates: Partial<Entity>): Promise<void> {
    await this.call('updateEntity', { id, updates });
  }

  // Proposals
  async createProposal(proposal: Proposal): Promise<string> {
    const result = await this.call('createProposal', proposal);
    return result.id;
  }

  async getProposal(id: string): Promise<Proposal | null> {
    return this.call('getProposal', { id });
  }

  async listProposals(status?: string): Promise<Proposal[]> {
    return this.call('listProposals', { status });
  }

  async updateProposal(id: string, updates: Partial<Proposal>): Promise<void> {
    await this.call('updateProposal', { id, updates });
  }

  // Audit logging
  async logAction(action: AuditAction): Promise<void> {
    await this.call('logAction', action);
  }

  async getAuditLog(filters?: AuditFilters): Promise<AuditAction[]> {
    return this.call('getAuditLog', { filters });
  }

  // Schema versions
  async getSchemaVersion(): Promise<number> {
    const result = await this.call('getSchemaVersion');
    return result.version;
  }

  async incrementSchemaVersion(description: string, changeKind: string): Promise<number> {
    const result = await this.call('incrementSchemaVersion', { description, changeKind });
    return result.version;
  }
}

// Singleton for use in the app
export const recordsStore = new RecordsStoreClient();
