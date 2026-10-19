/** gate.js - the only file api/ask.js imports. Both switches are OFF unless set; with neither set nothing else of the reader is loaded. */
const truthy = (v) => /^(?:1|true|on|yes)$/i.test(String(v ?? '').trim());
export const readerV2Wanted = () => truthy(process.env.DONOVAN_READER_V2) || truthy(process.env.DONOVAN_READER_V2_SHADOW);
export async function readerV2Hook(ctx, body) { return (await import('./app.js')).readerV2Hook(ctx, body); }
