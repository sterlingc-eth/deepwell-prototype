// Synthetic PDF builder shared by the demo-tryown checks (copied from scripts/verify-vision-lane.mjs; text pages and full-page image pages).
import { deflateSync } from 'node:zlib';
export function buildPdf(pages, { shared = false, inherit = false, filler = 0, formPage = null } = {}) {
  // pages: [{ text?: string[], image?: {w,h,raw(Buffer, RGB), flate?:true, extra?:string} }]
  const objs = []; // index = obj number - 1 ; strings or {dict, stream}
  const add = (o) => { objs.push(o); return objs.length; };
  const catalog = add(''); const pagesObj = add(''); const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  let sharedXo = '', sharedRes = 0;
  if (shared || inherit) {
    pages.forEach((pg, i) => { if (pg.image) { const im = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(pg.image.raw) }); pg.imNum = im; sharedXo += `/Im${i} ${im} 0 R `; } });
    sharedRes = add(`<< /Font << /F1 ${font} 0 R >> /XObject << ${sharedXo} >> >>`);
  }
  pages.forEach((pg, i) => {
    let content = ''; let xo = '';
    if (shared || inherit) { if (pg.image) content += `q 612 0 0 792 0 0 cm /Im${i} Do Q\n`; }
    else if (pg.image) {
      const data = deflateSync(pg.image.raw);
      const im = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ${pg.image.extra ?? ''}`, stream: data });
      xo = `/XObject << /Im0 ${im} 0 R >>`;
      content += `q 612 0 0 792 0 0 cm /Im0 Do Q\n`;
    }
    if (formPage === i) {
      const a = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${pg.image.w} /Height ${pg.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(pg.image.raw) });
      const b = add({ dict: `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(Buffer.alloc(192, 7)) });
      const fm = add({ dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /A ${a} 0 R /B ${b} 0 R >> >>`, stream: Buffer.from('q 612 0 0 792 0 0 cm /A Do Q') });
      xo = `/XObject << /Fm0 ${fm} 0 R >>`; content += '/Fm0 Do\n';
    }
    if (pg.text) pg.text.forEach((t, i) => { content += `BT /F1 11 Tf 72 ${720 - i * 16} Td (${t}) Tj ET\n`; });
    const cs = add({ dict: '<<', stream: Buffer.from(content, 'latin1') });
    const resEntry = shared ? `/Resources ${sharedRes} 0 R` : inherit ? '' : `/Resources << /Font << /F1 ${font} 0 R >> ${xo} >>`;
    const pn = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ${resEntry} /Contents ${cs} 0 R >>`);
    kids.push(pn);
  });
  if (filler) add({ dict: '<< /Type /Filler', stream: randomFillSync(Buffer.alloc(filler)) });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} ${inherit ? `/Resources ${sharedRes} 0 R` : ''} >>`;
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offs = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offs.push(pos);
    const head = typeof o === 'string' ? `${i + 1} 0 obj\n${o}\nendobj\n` : `${i + 1} 0 obj\n${o.dict.endsWith('<<') ? '<<' : o.dict} /Length ${o.stream.length} >>\nstream\n`;
    const b1 = Buffer.from(head, 'latin1'); parts.push(b1); pos += b1.length;
    if (typeof o !== 'string') { const tail = Buffer.concat([o.stream, Buffer.from('\nendstream\nendobj\n')]); parts.push(tail); pos += tail.length; }
  });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(x + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}
export const noise = (w, h, seed) => { const b = Buffer.alloc(w * h * 3); let s = seed >>> 0; for (let i = 0; i < b.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = ((i % (w * 3)) / 3 + (s >>> 24) / 4 + seed * 40) & 255; } return b; };
