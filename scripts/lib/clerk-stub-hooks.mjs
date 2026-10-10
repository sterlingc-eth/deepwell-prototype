// Module-customization hook: swaps '@clerk/backend' for a stub whose verifyToken() reads an unsigned
// "stub.<base64url JSON claims>" token. Test harnesses only (scripts/lib/t5-harness.mjs); never shipped.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@clerk/backend') {
    const src = "export async function verifyToken(t){ if(!String(t).startsWith('stub.')) throw new Error('bad token'); return JSON.parse(Buffer.from(String(t).slice(5),'base64url').toString('utf8')); }";
    return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
