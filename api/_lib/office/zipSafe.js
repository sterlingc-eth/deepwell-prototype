/**
 * A defensive, read-only ZIP reader for .docx/.xlsx. It never writes a file, never extracts to disk, never trusts a header:
 *   - the end-of-central-directory record and every central entry are bounds-checked; an entry count over MAX_ZIP_ENTRIES,
 *     a directory that does not fit in the file, or a record that runs off the end is a refusal (no partial read);
 *   - ZIP64, multi-disk archives and encrypted entries are refused with a plain message (we do not support them);
 *   - entry names with NUL, control characters, backslashes, a drive letter, a leading "/" or any ".." segment, and
 *     duplicate names, are refused (ambiguity between readers is how zip smuggling works). Names are only ever used as
 *     map keys here: nothing touches a filesystem;
 *   - the data ranges of all entries must not overlap each other or the directory (a lying / overlapping central
 *     directory, a "quine" bomb), and each local header must agree with the central one;
 *   - declared sizes are only a pre-filter. The REAL inflated length is measured with zlib's maxOutputLength, which is
 *     capped by the per-entry cap, by the ratio cap (inflated/compressed > MAX_ZIP_RATIO for anything over 1 MiB) and by
 *     what is left of the whole-archive budget; the real length must then equal the declared one and the CRC must match.
 */
import zlib from "node:zlib";
import {
  MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_INFLATED, MAX_ZIP_TOTAL_INFLATED, MAX_ZIP_RATIO,
} from "./limits.js";
import { OfficeError } from "./errors.js";

const NOT_A_FILE = (why) => new OfficeError(422, "bad-zip",
  `This file is damaged or is not a real Word/Excel file (${why}). Open it in Word or Excel, save it again as .docx or .xlsx, and upload again.`);
const UNSAFE = (why) => new OfficeError(422, "unsafe-zip",
  `This file's internal structure is not safe to read (${why}), so DeepWell will not open it. Open it in Word or Excel, save a fresh copy as .docx or .xlsx, and upload again.`);
const TOO_BIG = new OfficeError(413, "zip-too-large",
  "This file expands to far more data than a normal document, so DeepWell will not open it. Split it into smaller files, save a fresh copy, and upload again.");

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function checkName(name) {
  if (name.length === 0 || name.length > 512) throw UNSAFE("an entry name is empty or too long");
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 32 || c === 127 || c === 92) throw UNSAFE("an entry name contains control or backslash characters");
  }
  if (name.charCodeAt(0) === 47 || /^[A-Za-z]:/.test(name)) throw UNSAFE("an entry name is an absolute path");
  const parts = name.split("/");
  for (let k = 0; k < parts.length; k++) {
    if (parts[k] === ".." || (parts[k] === "." )) throw UNSAFE("an entry name tries to leave its folder");
  }
}

/** True if `buf` starts like a ZIP (local header, empty archive, or spanned marker). */
export function looksLikeZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6) || (buf[2] === 7 && buf[3] === 8));
}

/**
 * @returns {{names: string[], has(name):boolean, size(name):number|undefined, read(name, extraCap?):Buffer}}
 * @throws OfficeError
 */
export function openZip(buf, { clock } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22) throw NOT_A_FILE("too small");
  // End of central directory: scan back for its signature, at most 64 KiB of comment after it.
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let p = buf.length - 22; p >= lowest; p--) {
    if (buf[p] === 0x50 && buf[p + 1] === 0x4b && buf[p + 2] === 5 && buf[p + 3] === 6) {
      // the comment length must land exactly on the end of the file, else this is a stray signature inside a comment
      if (p + 22 + u16(buf, p + 20) === buf.length) { eocd = p; break; }
    }
  }
  if (eocd < 0) throw NOT_A_FILE("no zip directory: the file is cut off or not a zip");
  const diskNo = u16(buf, eocd + 4), cdDisk = u16(buf, eocd + 6);
  const entriesDisk = u16(buf, eocd + 8), total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12), cdOffset = u32(buf, eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesDisk !== total) throw UNSAFE("it is split across several disks");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new OfficeError(415, "zip64", "This file uses the ZIP64 format, which DeepWell does not read. Save a fresh, smaller copy as .docx or .xlsx and upload again.");
  }
  // A ZIP64 locator right before the EOCD means the real directory is elsewhere: unsupported.
  if (eocd >= 20 && u32(buf, eocd - 20) === 0x07064b50) {
    throw new OfficeError(415, "zip64", "This file uses the ZIP64 format, which DeepWell does not read. Save a fresh, smaller copy as .docx or .xlsx and upload again.");
  }
  if (total > MAX_ZIP_ENTRIES) throw new OfficeError(413, "zip-entries", `This file contains ${total} internal parts, more than DeepWell reads (${MAX_ZIP_ENTRIES}). Save a simpler copy and upload again.`);
  if (cdOffset + cdSize > eocd) throw NOT_A_FILE("its directory runs past the end of the file");

  const entries = new Map();
  const ranges = [];
  let p = cdOffset;
  let declaredTotal = 0;
  for (let k = 0; k < total; k++) {
    if (k % 256 === 0) clock?.check();
    if (p + 46 > cdOffset + cdSize || u32(buf, p) !== 0x02014b50) throw NOT_A_FILE("a directory record is damaged");
    const flags = u16(buf, p + 8), method = u16(buf, p + 10);
    const crc = u32(buf, p + 16), csize = u32(buf, p + 20), usize = u32(buf, p + 24);
    const nlen = u16(buf, p + 28), elen = u16(buf, p + 30), clen = u16(buf, p + 32);
    const lho = u32(buf, p + 42);
    if (p + 46 + nlen + elen + clen > cdOffset + cdSize) throw NOT_A_FILE("a directory record runs off its end");
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? rawName.toString("utf8") : rawName.toString("latin1");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) { // folder entry: no data, nothing to read
      checkName(name.slice(0, -1) || "x");
      continue;
    }
    checkName(name);
    if (entries.has(name)) throw UNSAFE("two entries share the same name");
    if (flags & 0x1 || flags & 0x40) throw new OfficeError(415, "encrypted",
      "This file is password-protected (encrypted), so it cannot be read. Remove the password in Word or Excel (File > Info > Protect), save it, and upload again.");
    if (method !== 0 && method !== 8) throw UNSAFE("an entry uses an unsupported compression method");
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new OfficeError(415, "zip64", "This file uses the ZIP64 format, which DeepWell does not read. Save a fresh, smaller copy as .docx or .xlsx and upload again.");
    if (usize > MAX_ZIP_ENTRY_INFLATED) throw TOO_BIG;
    if (usize > 1048576 && usize / Math.max(1, csize) > MAX_ZIP_RATIO) throw TOO_BIG;
    declaredTotal += usize;
    if (declaredTotal > MAX_ZIP_TOTAL_INFLATED) throw TOO_BIG;
    if (method === 0 && csize !== usize) throw UNSAFE("a stored entry has inconsistent sizes");
    // Local header: must be where the directory says, carry the same name length, and its data must fit before the directory.
    if (lho + 30 > cdOffset || u32(buf, lho) !== 0x04034b50) throw NOT_A_FILE("an entry's header is missing");
    const lflags = u16(buf, lho + 6);
    if (lflags & 0x1) throw new OfficeError(415, "encrypted", "This file is password-protected (encrypted), so it cannot be read. Remove the password in Word or Excel (File > Info > Protect), save it, and upload again.");
    const lnlen = u16(buf, lho + 26), lelen = u16(buf, lho + 28);
    if (lnlen !== nlen || !buf.subarray(lho + 30, lho + 30 + lnlen).equals(rawName)) throw UNSAFE("an entry's header disagrees with the directory");
    const dataStart = lho + 30 + lnlen + lelen;
    const dataEnd = dataStart + csize;
    if (dataEnd > cdOffset) throw UNSAFE("an entry's data overlaps the directory");
    ranges.push([lho, dataEnd]);
    entries.set(name, { method, crc, csize, usize, dataStart, dataEnd });
  }
  if (p !== cdOffset + cdSize && cdSize !== 0 && p > cdOffset + cdSize) throw NOT_A_FILE("the directory is inconsistent");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k][0] < ranges[k - 1][1]) throw UNSAFE("entries overlap each other");
  }

  let inflatedSoFar = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.usize,
    /** Real inflated bytes of one entry (cached by the caller if needed). Throws OfficeError. */
    read(name, cap = MAX_ZIP_ENTRY_INFLATED) {
      const e = entries.get(name);
      if (!e) throw NOT_A_FILE(`the part "${name.slice(0, 80)}" is missing`);
      clock?.check();
      const compressed = buf.subarray(e.dataStart, e.dataEnd);
      const budgetLeft = MAX_ZIP_TOTAL_INFLATED - inflatedSoFar;
      let out;
      if (e.method === 0) {
        if (e.usize > Math.min(cap, budgetLeft)) throw TOO_BIG;
        out = compressed;
      } else {
        // The ratio cap applies from 1 MiB up; below that, a small entry may inflate to 1 MiB at most however it compresses.
        const ratioCap = Math.max(1048576, compressed.length * MAX_ZIP_RATIO);
        const max = Math.min(cap, budgetLeft, ratioCap, MAX_ZIP_ENTRY_INFLATED);
        try {
          out = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, max) });
        } catch (err) {
          if (err && (err.code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(String(err.message)))) throw TOO_BIG;
          throw NOT_A_FILE("part of it is corrupt");
        }
      }
      if (out.length !== e.usize) throw UNSAFE("an entry's real size differs from its declared size");
      if (crc32(out) !== e.crc) throw NOT_A_FILE("an entry fails its integrity check (corrupt or tampered)");
      inflatedSoFar += out.length;
      return out;
    },
  };
}
