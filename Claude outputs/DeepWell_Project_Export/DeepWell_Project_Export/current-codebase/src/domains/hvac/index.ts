import { useGraph } from '../../core/entityGraph';
import { hvacSchema } from './schema';
import { buildDocuments, buildEntities } from './seed';

export { hvacSchema } from './schema';

/** Seed the entity graph with the HVAC mock. Idempotent. */
export function bootstrapHvac(): void {
  if (useGraph.getState().schema.id === hvacSchema.id) return;
  const { docs, batches, conflicts } = buildDocuments();
  useGraph.getState().seed(hvacSchema, buildEntities(), docs, batches, conflicts);
}
