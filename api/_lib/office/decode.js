/**
 * Decode a text file honestly instead of assuming UTF-8. (Moved here unchanged from readDocument.js so the CSV reader and
 * the ingest path share ONE implementation without an import cycle; readDocument.js re-exports it.)
 *
 * `bytes.toString("utf8")` on a UTF-16 file is garbage: a degree sign and an accented name come back as replacement
 * characters once the interleaved NUL bytes are stripped, and extraction then writes a customer name with a replacement
 * character in it. BOMs are checked first (unambiguous); without one UTF-16 is detected by the NUL bytes ASCII-range
 * characters leave in every other position. A file that is not valid UTF-8 is, in practice, Windows-1252.
 */
export function decodeText(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return swap16(bytes.subarray(2)).toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
  let evenNuls = 0;
  let oddNuls = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0x00) evenNuls++;
    if (sample[i + 1] === 0x00) oddNuls++;
  }
  const pairs = Math.floor(sample.length / 2);
  if (pairs >= 8) {
    if (oddNuls / pairs > 0.3 && evenNuls / pairs < 0.1) return bytes.toString("utf16le");
    if (evenNuls / pairs > 0.3 && oddNuls / pairs < 0.1) return swap16(bytes).toString("utf16le");
  }
  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return utf8;
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Big-endian UTF-16 to little-endian, so Node can decode it. */
function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}
