/** Industry question lanes (Build 2): one entry per capability pack that answers its trade's questions without a model. HVAC has none (its routers are the original chain). */
export async function laneForPack(pack) {
  if (pack?.id === 'electrical') return import('./electrical/lane.js').then((m) => ({ classify: m.classifyElectrical, run: m.runElectrical }));
  return null;
}
