import type { DemoFixture, DemoIndex } from './engine';

/** The industry list for the picker (small; bundled). */
const indexMod = import.meta.glob<DemoIndex>('./fixtures/index.json', { eager: true, import: 'default' });
export const DEMO_INDEX: DemoIndex = indexMod['./fixtures/index.json'] ?? { schema: 1, industries: [] };

// One lazily loaded chunk per industry, so picking an industry only downloads that industry's sample workspace.
const loaders = import.meta.glob<{ default: DemoFixture }>('./fixtures/*.demo.json');

export async function loadFixture(slug: string): Promise<DemoFixture | null> {
  const load = loaders[`./fixtures/${slug}.demo.json`];
  if (!load) return null;
  return (await load()).default;
}
