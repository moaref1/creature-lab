// In-app guides: every docs/*.md is bundled and shown here, so each template can be
// rebuilt from scratch step by step without leaving the app.
import React, { useState } from 'react';
import { Modal } from '../components/common';

const files = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Guide {
  id: string;
  title: string;
  body: string;
}
export const guides: Guide[] = Object.entries(files)
  .map(([path, body]) => ({ id: path.split('/').pop()!.replace(/\.md$/, ''), title: (body.match(/^#\s+(.+)$/m)?.[1] ?? path).trim(), body }))
  .sort((a, b) => a.title.localeCompare(b.title));

/** Which guide rebuilds a template (by template id). */
export const templateGuide: Record<string, string> = { fly: 'how-to-build-a-fly', smartFlies: 'how-to-build-smart-flies', sketch: 'how-to-build-a-sketch-creature', tidepool: 'how-to-build-tidepool' };

// ---------- tiny markdown renderer (headings, lists, tables, bold, italics, code) ----------
function inline(s: string, key: string | number): React.ReactNode {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<b key={i++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else out.push(<i key={i++}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return <React.Fragment key={key}>{out}</React.Fragment>;
}

function Markdown({ src }: { src: string }) {
  const lines = src.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,3}\s/.test(l)) {
      const lvl = l.match(/^#+/)![0].length;
      const text = l.replace(/^#+\s/, '');
      out.push(React.createElement(`h${lvl + 1}`, { key: i }, inline(text, 0)));
      i++;
    } else if (/^\s*\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      out.push(
        <table key={i} className="grid">
          <thead>
            <tr>{rows[0]?.map((c, k) => <th key={k}>{inline(c, k)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(1).map((r, k) => (
              <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, j)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
    } else if (/^\s*(\d+\.|-)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length && (/^\s*(\d+\.|-)\s/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const cur = lines[i];
        if (/^\s{2,}(\d+\.|-)\s/.test(cur) && items.length) items[items.length - 1].sub.push(cur.replace(/^\s*(\d+\.|-)\s/, ''));
        else if (/^\s{2,}\S/.test(cur) && !/^\s*(\d+\.|-)\s/.test(cur) && items.length) items[items.length - 1].text += ' ' + cur.trim();
        else items.push({ text: cur.replace(/^\s*(\d+\.|-)\s/, ''), sub: [] });
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      out.push(
        React.createElement(
          L,
          { key: i },
          items.map((it, k) => (
            <li key={k}>
              {inline(it.text, 0)}
              {it.sub.length > 0 && <ul>{it.sub.map((s, j) => <li key={j}>{inline(s, j)}</li>)}</ul>}
            </li>
          )),
        ),
      );
    } else if (l.trim()) {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\s*\||\s*(\d+\.|-)\s)/.test(lines[i])) para.push(lines[i++].trim());
      out.push(<p key={i}>{inline(para.join(' '), 0)}</p>);
    } else i++;
  }
  return <div className="guide-md">{out}</div>;
}

export function GuidesModal({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const [id, setId] = useState(initial && guides.some((g) => g.id === initial) ? initial : guides[0]?.id);
  const g = guides.find((x) => x.id === id);
  return (
    <Modal title="Guides" icon="book" onClose={onClose} width={900}>
      <div className="guides">
        <div className="guides-list">
          {guides.map((x) => (
            <div key={x.id} className={`item ${x.id === id ? 'on' : ''}`} onClick={() => setId(x.id)}>
              {x.title}
            </div>
          ))}
        </div>
        <div className="guides-body">{g ? <Markdown src={g.body} /> : 'No guides found.'}</div>
      </div>
    </Modal>
  );
}
