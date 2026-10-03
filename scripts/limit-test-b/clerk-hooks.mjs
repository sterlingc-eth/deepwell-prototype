export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@clerk/backend') return { url: new URL('./clerk-stub.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
