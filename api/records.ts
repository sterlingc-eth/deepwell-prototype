/**
 * Vercel API Handler - Postgres RecordsStore wrapper
 * Deploy as /api/records.ts (or split into separate files per resource)
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { PostgresRecordsStore } from '../src/services/postgresRecordsStore';

// Initialize connection pool (reuse across invocations)
let store: PostgresRecordsStore | null = null;

async function getStore(): Promise<PostgresRecordsStore> {
  if (!store) {
    const connString = process.env.NEON_CONNECTION_STRING;
    if (!connString) throw new Error('NEON_CONNECTION_STRING not set');
    store = new PostgresRecordsStore(connString);
  }
  return store;
}

interface ApiRequest extends VercelRequest {
  body: {
    action: string;
    tenantId?: string;
    [key: string]: any;
  };
}

export default async (req: ApiRequest, res: VercelResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, tenantId, ...payload } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'action required' });
    }

    const db = await getStore();

    // All operations require tenantId for RLS
    if (tenantId) {
      await db.connect(tenantId);
    }

    // Document operations
    if (action === 'createDocument') {
      const id = await db.createDocument(payload);
      return res.json({ id });
    }
    if (action === 'getDocument') {
      const doc = await db.getDocument(payload.id);
      return res.json(doc);
    }
    if (action === 'listDocuments') {
      const docs = await db.listDocuments(payload.filters);
      return res.json(docs);
    }
    if (action === 'updateDocument') {
      await db.updateDocument(payload.id, payload.updates);
      return res.json({ success: true });
    }

    // Facet operations
    if (action === 'createFacet') {
      const id = await db.createFacet(payload);
      return res.json({ id });
    }
    if (action === 'getFacet') {
      const facet = await db.getFacet(payload.id);
      return res.json(facet);
    }
    if (action === 'listFacetsByDocument') {
      const facets = await db.listFacetsByDocument(payload.documentId);
      return res.json(facets);
    }
    if (action === 'updateFacet') {
      await db.updateFacet(payload.id, payload.updates);
      return res.json({ success: true });
    }

    // Extraction operations
    if (action === 'createExtraction') {
      const id = await db.createExtraction(payload);
      return res.json({ id });
    }
    if (action === 'getExtraction') {
      const extraction = await db.getExtraction(payload.id);
      return res.json(extraction);
    }
    if (action === 'listExtractionsByDocument') {
      const extractions = await db.listExtractionsByDocument(payload.documentId);
      return res.json(extractions);
    }
    if (action === 'listExtractionsByEntity') {
      const extractions = await db.listExtractionsByEntity(payload.entityId);
      return res.json(extractions);
    }
    if (action === 'updateExtraction') {
      await db.updateExtraction(payload.id, payload.updates);
      return res.json({ success: true });
    }

    // Entity operations
    if (action === 'createEntity') {
      const id = await db.createEntity(payload);
      return res.json({ id });
    }
    if (action === 'getEntity') {
      const entity = await db.getEntity(payload.id);
      return res.json(entity);
    }
    if (action === 'listEntities') {
      const entities = await db.listEntities(payload.type);
      return res.json(entities);
    }
    if (action === 'updateEntity') {
      await db.updateEntity(payload.id, payload.updates);
      return res.json({ success: true });
    }

    // Proposal operations
    if (action === 'createProposal') {
      const id = await db.createProposal(payload);
      return res.json({ id });
    }
    if (action === 'getProposal') {
      const proposal = await db.getProposal(payload.id);
      return res.json(proposal);
    }
    if (action === 'listProposals') {
      const proposals = await db.listProposals(payload.status);
      return res.json(proposals);
    }
    if (action === 'updateProposal') {
      await db.updateProposal(payload.id, payload.updates);
      return res.json({ success: true });
    }

    // Audit operations
    if (action === 'logAction') {
      await db.logAction(payload);
      return res.json({ success: true });
    }
    if (action === 'getAuditLog') {
      const logs = await db.getAuditLog(payload.filters);
      return res.json(logs);
    }

    // Schema version operations
    if (action === 'getSchemaVersion') {
      const version = await db.getSchemaVersion();
      return res.json({ version });
    }
    if (action === 'incrementSchemaVersion') {
      const version = await db.incrementSchemaVersion(payload.description, payload.changeKind);
      return res.json({ version });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Internal server error',
    });
  }
};
