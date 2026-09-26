import type { Entity } from './types';

/**
 * Maps a local entity-graph record to the node id the Knowledge Graph API
 * contract uses for that record ('customer:<uuid>', 'unit:<uuid>',
 * 'site:<uuid>', 'tech:<name>', 'visit:<uuid>') — so a Graph entry point
 * (CustomerProfileScreen, EntityScreen) can seed the view with the same id
 * the backend already knows this record by, instead of reinventing one.
 * `technician` is the one type keyed by name rather than id (the contract's
 * 'tech:<name>' form); everything else uses the local record id, which is
 * the closest thing this frontend has to the backend's own key for it.
 *
 * Kept in its own module (not KnowledgeGraph.tsx) purely so that component
 * file only exports the component — oxlint's react-refresh rule flags a
 * file that exports both, and every other component in src/components/
 * follows the same split (see StagePill.tsx/WarrantyStatusBadge.tsx).
 */
export function entityNodeId(entity: Pick<Entity, 'id' | 'type' | 'fields'>): string | null {
  switch (entity.type) {
    case 'equipment':
      return `unit:${entity.id}`;
    // Backend site nodes are keyed by canonical address and there is no visit node type yet,
    // so these local records have no graph node to seed from.
    case 'property':
    case 'service':
      return null;
    case 'technician': {
      const name = typeof entity.fields.name === 'string' && entity.fields.name.trim() ? entity.fields.name : entity.id;
      return `tech:${name}`;
    }
    case 'customer':
      return `customer:${entity.id}`;
    default:
      return null;
  }
}

export function customerNodeId(customerId: string): string {
  return `customer:${customerId}`;
}
