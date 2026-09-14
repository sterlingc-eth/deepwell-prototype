/**
 * Postgres RecordsStore Implementation
 * Replaces IndexedDB, same interface
 * Handles: documents, facets, extractions, entities, proposals, audit logs
 */

type Client = any; // Stub for pg.Client - install 'pg' when ready
// import { Client } from 'pg';

export interface RecordsStore {
  // Connection management
  connect(tenantId: string): Promise<void>;
  disconnect(): Promise<void>;

  // Documents
  createDocument(doc: Document): Promise<string>;
  getDocument(id: string): Promise<Document | null>;
  listDocuments(filters?: DocumentFilters): Promise<Document[]>;
  updateDocument(id: string, updates: Partial<Document>): Promise<void>;

  // Facets (OCR extractions)
  createFacet(facet: Facet): Promise<string>;
  getFacet(id: string): Promise<Facet | null>;
  listFacetsByDocument(documentId: string): Promise<Facet[]>;
  updateFacet(id: string, updates: Partial<Facet>): Promise<void>;

  // Extractions (mapped data)
  createExtraction(extraction: Extraction): Promise<string>;
  getExtraction(id: string): Promise<Extraction | null>;
  listExtractionsByDocument(documentId: string): Promise<Extraction[]>;
  listExtractionsByEntity(entityId: string): Promise<Extraction[]>;
  updateExtraction(id: string, updates: Partial<Extraction>): Promise<void>;

  // Entities (properties, equipment, customers, technicians)
  createEntity(entity: Entity): Promise<string>;
  getEntity(id: string): Promise<Entity | null>;
  listEntities(type?: string): Promise<Entity[]>;
  updateEntity(id: string, updates: Partial<Entity>): Promise<void>;

  // Proposals (schema growth)
  createProposal(proposal: Proposal): Promise<string>;
  getProposal(id: string): Promise<Proposal | null>;
  listProposals(status?: string): Promise<Proposal[]>;
  updateProposal(id: string, updates: Partial<Proposal>): Promise<void>;

  // Audit logging
  logAction(action: AuditAction): Promise<void>;
  getAuditLog(filters?: AuditFilters): Promise<AuditAction[]>;

  // Schema versions
  getSchemaVersion(): Promise<number>;
  incrementSchemaVersion(description: string, changeKind: string): Promise<number>;
}

// Type definitions matching the schema
export interface Document {
  id: string;
  tenant_id: string;
  batch_id?: string;
  original_filename: string;
  document_type?: string;
  sha256_hash: string;
  file_size_bytes?: number;
  stage: 'received' | 'read' | 'mapped' | 'linked' | 'verified';
  created_at: Date;
  processed_at?: Date;
}

export interface DocumentFilters {
  stage?: string;
  document_type?: string;
  batch_id?: string;
}

export interface Facet {
  id: string;
  tenant_id: string;
  document_id: string;
  page_no?: number;
  segment_id?: string;
  label_raw: string;
  value_raw: string;
  value_type_guess?: string;
  bbox?: Record<string, any>;
  confidence?: number;
  mapped_entity_type?: string;
  mapped_field_key?: string;
  mapping_confidence?: number;
  mapping_method?: 'registry' | 'synonym' | 'learned' | 'human';
  proposal_id?: string;
  created_at: Date;
}

export interface Extraction {
  id: string;
  tenant_id: string;
  document_id: string;
  entity_id?: string;
  field_key: string;
  value?: string;
  confidence?: number;
  source_facet_id?: string;
  schema_version?: number;
  created_at: Date;
}

export interface Entity {
  id: string;
  tenant_id: string;
  entity_type: 'property' | 'equipment' | 'customer' | 'technician';
  data: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface Proposal {
  id: string;
  tenant_id: string;
  kind: 'field' | 'synonym' | 'document_type' | 'entity_type';
  label: string;
  target_entity_type?: string;
  target_field_key?: string;
  evidence?: Record<string, any>;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: Date;
  resolved_at?: Date;
  resolved_by?: string;
}

export interface AuditAction {
  id: string;
  tenant_id: string;
  user_id?: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  changes?: Record<string, any>;
  created_at: Date;
}

export interface AuditFilters {
  action?: string;
  resource_type?: string;
  resource_id?: string;
  user_id?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Postgres implementation of RecordsStore
 */
export class PostgresRecordsStore implements RecordsStore {
  private client: Client;
  private tenantId: string | null = null;

  constructor(connectionString: string) {
    this.client = new Client({ connectionString });
  }

  async connect(tenantId: string): Promise<void> {
    await this.client.connect();
    this.tenantId = tenantId;
    // Set RLS context for tenant isolation
    await this.client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
  }

  async disconnect(): Promise<void> {
    await this.client.end();
  }

  private async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows;
  }

  private async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const result = await this.client.query(sql, params);
    return result.rows[0] || null;
  }

  private async execute(sql: string, params: any[] = []): Promise<void> {
    await this.client.query(sql, params);
  }

  // Documents
  async createDocument(doc: Document): Promise<string> {
    const result = await this.queryOne<{ id: string }>(
      `INSERT INTO documents
       (tenant_id, batch_id, original_filename, document_type, sha256_hash, file_size_bytes, stage, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [doc.tenant_id, doc.batch_id, doc.original_filename, doc.document_type,
       doc.sha256_hash, doc.file_size_bytes, doc.stage]
    );
    return result!.id;
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.queryOne<Document>(
      `SELECT * FROM documents WHERE id = $1`,
      [id]
    );
  }

  async listDocuments(filters?: DocumentFilters): Promise<Document[]> {
    let sql = 'SELECT * FROM documents WHERE tenant_id = (current_setting(\'app.tenant_id\'))::uuid';
    const params: any[] = [];

    if (filters?.stage) {
      sql += ` AND stage = $${params.length + 1}`;
      params.push(filters.stage);
    }
    if (filters?.document_type) {
      sql += ` AND document_type = $${params.length + 1}`;
      params.push(filters.document_type);
    }
    if (filters?.batch_id) {
      sql += ` AND batch_id = $${params.length + 1}`;
      params.push(filters.batch_id);
    }

    sql += ' ORDER BY created_at DESC';
    return this.query<Document>(sql, params);
  }

  async updateDocument(id: string, updates: Partial<Document>): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.stage !== undefined) {
      setClauses.push(`stage = $${paramIndex++}`);
      params.push(updates.stage);
    }
    if (updates.processed_at !== undefined) {
      setClauses.push(`processed_at = $${paramIndex++}`);
      params.push(updates.processed_at);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.execute(
      `UPDATE documents SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  // Facets
  async createFacet(facet: Facet): Promise<string> {
    const result = await this.queryOne<{ id: string }>(
      `INSERT INTO facets
       (tenant_id, document_id, page_no, segment_id, label_raw, value_raw, value_type_guess,
        bbox, confidence, mapped_entity_type, mapped_field_key, mapping_confidence,
        mapping_method, proposal_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       RETURNING id`,
      [facet.tenant_id, facet.document_id, facet.page_no, facet.segment_id,
       facet.label_raw, facet.value_raw, facet.value_type_guess,
       JSON.stringify(facet.bbox), facet.confidence, facet.mapped_entity_type,
       facet.mapped_field_key, facet.mapping_confidence, facet.mapping_method,
       facet.proposal_id]
    );
    return result!.id;
  }

  async getFacet(id: string): Promise<Facet | null> {
    return this.queryOne<Facet>(
      `SELECT * FROM facets WHERE id = $1`,
      [id]
    );
  }

  async listFacetsByDocument(documentId: string): Promise<Facet[]> {
    return this.query<Facet>(
      `SELECT * FROM facets
       WHERE document_id = $1 AND tenant_id = (current_setting('app.tenant_id'))::uuid
       ORDER BY page_no, segment_id`,
      [documentId]
    );
  }

  async updateFacet(id: string, updates: Partial<Facet>): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.mapped_entity_type !== undefined) {
      setClauses.push(`mapped_entity_type = $${paramIndex++}`);
      params.push(updates.mapped_entity_type);
    }
    if (updates.mapped_field_key !== undefined) {
      setClauses.push(`mapped_field_key = $${paramIndex++}`);
      params.push(updates.mapped_field_key);
    }
    if (updates.mapping_confidence !== undefined) {
      setClauses.push(`mapping_confidence = $${paramIndex++}`);
      params.push(updates.mapping_confidence);
    }
    if (updates.mapping_method !== undefined) {
      setClauses.push(`mapping_method = $${paramIndex++}`);
      params.push(updates.mapping_method);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.execute(
      `UPDATE facets SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  // Extractions
  async createExtraction(extraction: Extraction): Promise<string> {
    const result = await this.queryOne<{ id: string }>(
      `INSERT INTO extractions
       (tenant_id, document_id, entity_id, field_key, value, confidence, source_facet_id, schema_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id`,
      [extraction.tenant_id, extraction.document_id, extraction.entity_id, extraction.field_key,
       extraction.value, extraction.confidence, extraction.source_facet_id, extraction.schema_version]
    );
    return result!.id;
  }

  async getExtraction(id: string): Promise<Extraction | null> {
    return this.queryOne<Extraction>(
      `SELECT * FROM extractions WHERE id = $1`,
      [id]
    );
  }

  async listExtractionsByDocument(documentId: string): Promise<Extraction[]> {
    return this.query<Extraction>(
      `SELECT * FROM extractions
       WHERE document_id = $1 AND tenant_id = (current_setting('app.tenant_id'))::uuid
       ORDER BY created_at DESC`,
      [documentId]
    );
  }

  async listExtractionsByEntity(entityId: string): Promise<Extraction[]> {
    return this.query<Extraction>(
      `SELECT * FROM extractions
       WHERE entity_id = $1 AND tenant_id = (current_setting('app.tenant_id'))::uuid
       ORDER BY created_at DESC`,
      [entityId]
    );
  }

  async updateExtraction(id: string, updates: Partial<Extraction>): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.value !== undefined) {
      setClauses.push(`value = $${paramIndex++}`);
      params.push(updates.value);
    }
    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      params.push(updates.confidence);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.execute(
      `UPDATE extractions SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  // Entities
  async createEntity(entity: Entity): Promise<string> {
    const result = await this.queryOne<{ id: string }>(
      `INSERT INTO entities
       (tenant_id, entity_type, data, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id`,
      [entity.tenant_id, entity.entity_type, JSON.stringify(entity.data)]
    );
    return result!.id;
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.queryOne<Entity>(
      `SELECT * FROM entities WHERE id = $1`,
      [id]
    );
  }

  async listEntities(type?: string): Promise<Entity[]> {
    let sql = `SELECT * FROM entities WHERE tenant_id = (current_setting('app.tenant_id'))::uuid`;
    const params: any[] = [];

    if (type) {
      sql += ` AND entity_type = $1`;
      params.push(type);
    }

    sql += ' ORDER BY created_at DESC';
    return this.query<Entity>(sql, params);
  }

  async updateEntity(id: string, updates: Partial<Entity>): Promise<void> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: any[] = [];

    if (updates.data !== undefined) {
      setClauses.push(`data = $${setClauses.length}`);
      params.push(JSON.stringify(updates.data));
    }

    params.push(id);
    await this.execute(
      `UPDATE entities SET ${setClauses.join(', ')} WHERE id = $${setClauses.length + 1}`,
      params
    );
  }

  // Proposals
  async createProposal(proposal: Proposal): Promise<string> {
    const result = await this.queryOne<{ id: string }>(
      `INSERT INTO proposals
       (tenant_id, kind, label, target_entity_type, target_field_key, evidence, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [proposal.tenant_id, proposal.kind, proposal.label, proposal.target_entity_type,
       proposal.target_field_key, JSON.stringify(proposal.evidence), proposal.status]
    );
    return result!.id;
  }

  async getProposal(id: string): Promise<Proposal | null> {
    return this.queryOne<Proposal>(
      `SELECT * FROM proposals WHERE id = $1`,
      [id]
    );
  }

  async listProposals(status?: string): Promise<Proposal[]> {
    let sql = `SELECT * FROM proposals WHERE tenant_id = (current_setting('app.tenant_id'))::uuid`;
    const params: any[] = [];

    if (status) {
      sql += ` AND status = $1`;
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC';
    return this.query<Proposal>(sql, params);
  }

  async updateProposal(id: string, updates: Partial<Proposal>): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.resolved_at !== undefined) {
      setClauses.push(`resolved_at = $${paramIndex++}`);
      params.push(updates.resolved_at);
    }
    if (updates.resolved_by !== undefined) {
      setClauses.push(`resolved_by = $${paramIndex++}`);
      params.push(updates.resolved_by);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.execute(
      `UPDATE proposals SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  // Audit logging
  async logAction(action: AuditAction): Promise<void> {
    await this.execute(
      `INSERT INTO audit_log
       (tenant_id, user_id, action, resource_type, resource_id, changes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [action.tenant_id, action.user_id, action.action, action.resource_type,
       action.resource_id, JSON.stringify(action.changes)]
    );
  }

  async getAuditLog(filters?: AuditFilters): Promise<AuditAction[]> {
    let sql = `SELECT * FROM audit_log WHERE tenant_id = (current_setting('app.tenant_id'))::uuid`;
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.action) {
      sql += ` AND action = $${paramIndex++}`;
      params.push(filters.action);
    }
    if (filters?.resource_type) {
      sql += ` AND resource_type = $${paramIndex++}`;
      params.push(filters.resource_type);
    }
    if (filters?.resource_id) {
      sql += ` AND resource_id = $${paramIndex++}`;
      params.push(filters.resource_id);
    }
    if (filters?.user_id) {
      sql += ` AND user_id = $${paramIndex++}`;
      params.push(filters.user_id);
    }
    if (filters?.startDate) {
      sql += ` AND created_at >= $${paramIndex++}`;
      params.push(filters.startDate);
    }
    if (filters?.endDate) {
      sql += ` AND created_at <= $${paramIndex++}`;
      params.push(filters.endDate);
    }

    sql += ' ORDER BY created_at DESC';
    return this.query<AuditAction>(sql, params);
  }

  // Schema versions
  async getSchemaVersion(): Promise<number> {
    const result = await this.queryOne<{ version: number }>(
      `SELECT version FROM schema_versions
       WHERE tenant_id = (current_setting('app.tenant_id'))::uuid
       ORDER BY version DESC LIMIT 1`
    );
    return result?.version ?? 1;
  }

  async incrementSchemaVersion(description: string, changeKind: string): Promise<number> {
    const currentVersion = await this.getSchemaVersion();
    const newVersion = currentVersion + 1;

    await this.execute(
      `INSERT INTO schema_versions
       (tenant_id, version, change_kind, description, created_at)
       VALUES ((current_setting('app.tenant_id'))::uuid, $1, $2, $3, NOW())`,
      [newVersion, changeKind, description]
    );

    return newVersion;
  }
}
