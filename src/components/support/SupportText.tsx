import type { ReactNode } from 'react';

/**
 * Renders assistant reply text without dangerouslySetInnerHTML. Supports exactly what the API promises:
 * plain text with line breaks, **bold**, and bare https:// / mailto: links (bare email addresses are linked
 * too). Anything else, including HTML, is rendered as literal text by React.
 */
const TOKEN = /\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const TRAILING = /[.,;:!?)\]]+$/;

const linkClass = 'underline underline-offset-2 font-medium text-accent-ink break-words hover:opacity-80';

function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function inline(line: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of line.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > last) out.push(line.slice(last, start));
    const key = `${keyBase}-${n++}`;
    if (m[1] != null) {
      out.push(<strong key={key}>{m[1]}</strong>);
    } else {
      let target = m[2] ?? `mailto:${m[3]}`;
      let tail = '';
      const t = TRAILING.exec(m[2] ? target : '');
      if (t) {
        tail = t[0];
        target = target.slice(0, -tail.length);
      }
      const href = safeHref(target);
      const label = target.replace(/^mailto:/, '');
      out.push(
        href ? (
          <a key={key} href={href} className={linkClass} {...(href.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {label}
          </a>
        ) : (
          target
        ),
      );
      if (tail) out.push(tail);
    }
    last = start + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function SupportText({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return (
    <div className={className}>
      {lines.map((line, i) =>
        line.trim() === '' ? (
          <div key={i} className="h-2" aria-hidden="true" />
        ) : (
          <p key={i} className={`m-0 break-words ${/^\s*(?:[-*•]|\d+[.)])\s/.test(line) ? 'pl-4 -indent-4' : ''}`}>
            {inline(line, String(i))}
          </p>
        ),
      )}
    </div>
  );
}
