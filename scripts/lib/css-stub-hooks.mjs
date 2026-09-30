// Module-customization hooks that turn any stylesheet import (`import './x.css'`) into an empty module, so a
// Node/tsx verify script can import React source files that pull CSS in through the app's component tree.
export async function load(url, context, nextLoad) {
  if (/\.(css|scss|sass|less)(\?.*)?$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return nextLoad(url, context);
}
