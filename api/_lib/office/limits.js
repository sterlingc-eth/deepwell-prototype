/**
 * Office files (Word / Excel / CSV): ONE place for every number that decides how a file is read, counted and refused.
 * Imported by the readers (api/_lib/office/*), the upload allow-list (api/_lib/uploadTypes.js) and the page estimate
 * (api/_lib/plan.js). Change a number here and every one of them follows. Pure constants, no imports.
 */

// Upload size caps (compressed bytes as uploaded), applied to EVERY type, including a file with no declared type.
export const MAX_OFFICE_UPLOAD_BYTES = 20 * 1024 * 1024; // .docx / .xlsx (zip files)
export const MAX_SHEET_TEXT_UPLOAD_BYTES = 20 * 1024 * 1024; // .csv / .tsv (same as the existing text cap)

// Page-counting rule (monthly page allowance). A "page" is one document_pages row, which is also what the monthly counter counts.
//   Word (.docx): one page per ~3,000 characters of extracted text (about one printed page), at least 1 page.
//   Excel (.xlsx) and CSV: one page per sheet chunk; a chunk is the header row(s) plus as many data rows as fit in
//   ~6,000 characters; every non-empty sheet is at least 1 page; an empty sheet is 0 pages. (6,000 = the existing CSV/text page.)
//   Plain .txt / .md / .json: unchanged, one page per 6,000 characters.
export const WORD_PAGE_CHARS = 3000;
export const SHEET_CHUNK_CHARS = 6000;

// The page count above is the REAL count, set when the file is read. The count shown before reading is only an estimate from the
// file size and can be far lower for very repetitive files (a small file of repeated text can read as hundreds of pages), so the
// real count is checked against the company's remaining monthly pages at read time (readDocument.js officeAllowanceRefusal): a
// file that would not fit is refused (402) and nothing is counted. Hidden Word text (w:vanish) is not read; hidden Excel sheets are
// read and marked; tracked deletions are dropped.

// Hard caps on what a reader will ever look at (a hostile or merely huge file stops here, cleanly, with a plain message).
export const MAX_ZIP_ENTRIES = 2000; // entries in the archive
export const MAX_ZIP_ENTRY_INFLATED = 64 * 1024 * 1024; // one entry, after inflating
export const MAX_ZIP_TOTAL_INFLATED = 128 * 1024 * 1024; // all entries read, after inflating
export const MAX_ZIP_RATIO = 1000; // inflated / compressed for any one entry larger than 1 MiB
export const MAX_XML_DEPTH = 256;
export const MAX_SHEETS = 64;
export const MAX_ROWS_PER_SHEET = 200_000;
export const MAX_CELLS = 2_000_000; // across the whole workbook
export const MAX_COLS_PER_ROW = 1_000;
export const MAX_CELL_CHARS = 32_767; // Excel's own limit
export const MAX_TOTAL_CHARS = 12_000_000; // extracted text per file (about 2,000 sheet-chunk pages)
export const MAX_PAGES_PER_FILE = 2_000;
export const READ_TIMEOUT_MS = 20_000; // wall clock for one file's parse

// Upload-time page ESTIMATE (api/_lib/plan.js estimatePagesForUpload + recordsStore estimatePendingPages). Before a file is read only its
// compressed size and type are known, so these are calibrated rates, deliberately on the low-bytes-per-page side so the estimate
// is never less than half of what is finally counted (it can be much higher for files full of pictures, which the reader ignores;
// the estimate is only a gate and is replaced by the real document_pages count once the file is read). Calibrated against
// text-only, table-heavy and numeric files; measured accuracy is in docs/help/billing and scripts/verify-office-uploads.mjs.
export const ESTIMATE_DOCX_FIXED_BYTES = 6_000; // a Word file's styles/theme/settings parts, whatever the text
export const ESTIMATE_DOCX_BYTES_PER_PAGE = 1_500; // compressed bytes per ~3,000 characters of text
export const ESTIMATE_XLSX_FIXED_BYTES = 2_000; // the workbook's styles/theme parts
export const ESTIMATE_XLSX_BYTES_PER_PAGE = 1_500; // compressed bytes per sheet chunk (~6,000 characters of rendered cells)
export const ESTIMATE_CSV_BYTES_PER_PAGE = 3_000; // csv/tsv: a ~6,000-character chunk renders about 3,000 bytes of CSV (the reader labels each cell and repeats the header)
export const ESTIMATE_DOCX_MAX_PAGES = 200; // a Word file's size is mostly pictures the reader ignores, so a big one must not eat the whole allowance (same per-file cap PDFs and text already have)
export const ESTIMATE_SHEET_MAX_PAGES = MAX_PAGES_PER_FILE; // Excel/CSV size is nearly all cells: never estimate more than the reader would ever write
