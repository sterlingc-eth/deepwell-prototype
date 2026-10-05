// Types for uploadTypes.js so the browser code (src/services/*) can import the SAME allow-list the server enforces.
export const ACCEPTED_TYPES_SENTENCE: string;
export const EXT_KIND: Record<string, 'pdf' | 'image' | 'text' | 'sheet-text' | 'docx' | 'xlsx'>;
export const EXT_CONTENT_TYPES: Record<string, string[]>;
export const ACCEPT_ATTRIBUTE: string;
export const DOCX_CONTENT_TYPE: string;
export const XLSX_CONTENT_TYPE: string;
export const MAX_ABSOLUTE_BYTES: number;
export const MAX_MODEL_READ_BYTES: number;
export const KIND_CAP_BYTES: Record<string, number>;
export const SIZE_ABSOLUTE_MESSAGE: string;
export const SIZE_TEXT_MESSAGE: string;
export const SIZE_MODEL_MESSAGE: string;
export const SIZE_OFFICE_MESSAGE: string;
export const HEIC_MESSAGE: string;
export const NO_EXTENSION_MESSAGE: string;
export function refusalForExtension(ext: string): string;
export function extensionOf(filename: unknown): string;
export type UploadCheck =
  | { ok: true; kind: string; contentType: string; ext: string }
  | { ok: false; status: number; message: string };
export function checkUploadFile(f: { filename: unknown; contentType?: unknown; sizeBytes?: unknown }): UploadCheck;
