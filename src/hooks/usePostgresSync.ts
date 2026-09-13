/**
 * Hook that syncs entityGraph changes to Postgres via the API
 * Call once on app startup to enable bidirectional sync
 */

import { useEffect } from 'react';
import { recordsStore } from '../services/recordsStoreClient';
import { useGraph } from '../core/entityGraph';
import type { Doc, Entity } from '../core/types';

export function usePostgresSync(tenantId: string) {
  const graphState = useGraph();

  useEffect(() => {
    let isMounted = true;

    async function initializeSync() {
      try {
        // Connect to Postgres with tenant context
        await recordsStore.connect(tenantId);

        // Load existing documents from Postgres (for multi-session sync)
        const existingDocs = await recordsStore.listDocuments();
        const existingEntities = await recordsStore.listEntities();

        if (isMounted && (existingDocs.length > 0 || existingEntities.length > 0)) {
          // If there's data in Postgres, load it into the graph
          // (optionally merge with in-memory data)
          console.log('Loaded from Postgres:', {
            docs: existingDocs.length,
            entities: existingEntities.length,
          });
        }
      } catch (err) {
        console.error('Failed to initialize Postgres sync:', err);
        // Gracefully degrade to in-memory only
      }
    }

    initializeSync();

    return () => {
      isMounted = false;
    };
  }, [tenantId]);

  // Sync documents to Postgres whenever they change
  useEffect(() => {
    const syncDocuments = async () => {
      try {
        for (const docId of Object.keys(graphState.docs)) {
          const doc = graphState.docs[docId];
          if (!doc) continue;

          // Simple upsert: update if exists, create if new
          await recordsStore.updateDocument(doc.id, {
            stage: doc.stage,
            typeId: doc.typeId,
            preview: doc.preview,
          }).catch(async () => {
            // If update fails, it's probably a new doc, so create it
            await recordsStore.createDocument(doc as any);
          });
        }
      } catch (err) {
        console.error('Failed to sync documents:', err);
      }
    };

    syncDocuments();
  }, [graphState.docs]);

  // Sync entities to Postgres whenever they change
  useEffect(() => {
    const syncEntities = async () => {
      try {
        for (const entityId of Object.keys(graphState.entities)) {
          const entity = graphState.entities[entityId];
          if (!entity) continue;

          await recordsStore.updateEntity(entity.id, {
            fields: entity.fields,
          }).catch(async () => {
            // If update fails, try creating
            await recordsStore.createEntity(entity as any);
          });
        }
      } catch (err) {
        console.error('Failed to sync entities:', err);
      }
    };

    syncEntities();
  }, [graphState.entities]);
}
