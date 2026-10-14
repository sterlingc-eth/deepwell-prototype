/**
 * handoffLearning/source.js - Google policy: nothing that came from a Google Drive / Gmail sync may feed any learning.
 * A record is "Google-sourced" when any source-ish field names Google / Gmail / Drive, or a link/id points at Google. Unknown source = not Google (uploads, scans, imports).
 */
const KEYS = ['source', 'source_system', 'sourceSystem', 'origin', 'provider', 'connector', 'import_source', 'importSource', 'sync_source', 'syncSource', 'channel', 'storage', 'integration'];
const NAME = /(?:google|gmail|g-?suite|gdrive|g_drive|drive[-_ ]?sync|workspace[-_ ]?sync|googleapis)/i;
const LINK = /(?:docs|drive|mail)\.google\.com|googleusercontent\.com|mail\.google/i;
export function isGoogleSourced(rec) {
  if (!rec || typeof rec !== 'object') return false;
  for (const k of KEYS) { const v = rec[k]; if (typeof v === 'string' && NAME.test(v)) return true; if (v && typeof v === 'object' && NAME.test(JSON.stringify(v))) return true; }
  for (const k of ['url', 'link', 'webViewLink', 'web_view_link', 'file_url', 'fileUrl', 'storage_path', 'storagePath']) { const v = rec[k]; if (typeof v === 'string' && LINK.test(v)) return true; }
  for (const k of ['metadata', 'meta', 'provenance']) { const v = rec[k]; if (v && typeof v === 'object') { try { const s = JSON.stringify(v); if (NAME.test(s) || LINK.test(s)) return true; } catch { /* ignore */ } } }
  if (rec.gmail_message_id || rec.gmailMessageId || rec.drive_file_id || rec.driveFileId || rec.google_file_id) return true;
  return false;
}
