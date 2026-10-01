import { Fragment, type ReactNode } from 'react';

/**
 * Bewusst kleiner Markdown-Renderer: erzeugt React-Elemente statt HTML,
 * damit kein fremder Text jemals als Markup ausgeführt werden kann.
 * Unterstützt Codeblöcke, Inline-Code, fett, kursiv, durchgestrichen,
 * Links, Zitate, Listen, @Erwähnungen und #Kanäle.
 */

interface Props {
  text: string;
  selfHandle?: string;
  onMention?: (handle: string) => void;
  onChannel?: (name: string) => void;
}

export function Markdown({ text, selfHandle, onMention, onChannel }: Props) {
  return <div className="md">{renderBlocks(text, { selfHandle, onMention, onChannel })}</div>;
}

interface Ctx {
  selfHandle?: string;
  onMention?: (handle: string) => void;
  onChannel?: (name: string) => void;
}

function renderBlocks(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Codeblock
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // schließendes ```
      out.push(
        <pre key={key++}><code data-lang={fence[1] || undefined}>{body.join('\n')}</code></pre>,
      );
      continue;
    }

    // Zitat
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(<blockquote key={key++}>{renderBlocks(body.join('\n'), ctx)}</blockquote>);
      continue;
    }

    // Listen
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push(<ul key={key++}>{items.map((it, n) => <li key={n}>{renderInline(it, ctx)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      out.push(<ol key={key++}>{items.map((it, n) => <li key={n}>{renderInline(it, ctx)}</li>)}</ol>);
      continue;
    }

    // Absatz (bis zur nächsten Leerzeile)
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i])
           && !/^>\s?/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    if (para.length) {
      out.push(
        <p key={key++}>
          {para.map((l, n) => (
            <Fragment key={n}>{n > 0 && <br />}{renderInline(l, ctx)}</Fragment>
          ))}
        </p>,
      );
    } else {
      i++; // Leerzeile
    }
  }

  return out;
}

const INLINE_RE = new RegExp(
  [
    '(`[^`\\n]+`)',                                     // 1 Inline-Code
    '(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)',              // 2 fett
    '(\\*[^*\\n]+\\*|_[^_\\n]+_)',                      // 3 kursiv
    '(~~[^~\\n]+~~)',                                   // 4 durchgestrichen
    '(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))',                 // 5 [Text](url)
    '(https?://[^\\s<]+)',                              // 6 nackte URL
    // 7 Erwähnung — nur an einer echten Wortgrenze davor: Zeilenanfang,
    // Leerraum oder ein öffnendes Klammer-/Anführungszeichen. NIE ein
    // Buchstabe, eine Ziffer oder ein "_", denn dann steckt das "@" MITTEN
    // in einem Wort — genau der Fall bei einer E-Mail-Adresse
    // ("nutzer@beispiel.test", das "n" davor ist ein Buchstabe) oder einem
    // Passwort-Fragment ("…9@R6…", die "9" davor ist eine Ziffer). Ein
    // Lookbehind statt einer eigenen Gruppe, damit `raw` weiter exakt beim
    // "@" beginnt und die Index-Buchhaltung darunter unverändert bleibt.
    '(?<![\\p{L}\\p{N}_])(@[a-zA-Z0-9_.-]{2,32})',      // 7 Erwähnung
    // 8 Kanal — dieselbe Wortgrenze wie bei der Erwähnung, aus demselben
    // Grund. \p{L}\p{N} statt a-zA-Z0-9äöüß: #продажи, #売上, #satış
    // brauchten sonst rohen Text.
    '(?<![\\p{L}\\p{N}_])(#[\\p{L}\\p{N}_-]{2,48})',    // 8 Kanal
  ].join('|'),
  'gu',
);

function renderInline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const m of text.matchAll(INLINE_RE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const [raw] = m;

    if (m[1]) {
      out.push(<code key={key++}>{raw.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key++}>{renderInline(raw.slice(2, -2), ctx)}</strong>);
    } else if (m[3]) {
      out.push(<em key={key++}>{renderInline(raw.slice(1, -1), ctx)}</em>);
    } else if (m[4]) {
      out.push(<del key={key++}>{renderInline(raw.slice(2, -2), ctx)}</del>);
    } else if (m[5]) {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(raw);
      // Nur http(s) wird zum Link: "[klick](javascript:…)" landete sonst im
      // Browser ungeprüft in window.open — dort fehlt die Prüfung, die der
      // Electron-Hauptprozess vor shell.openExternal macht.
      if (link && /^https?:\/\//i.test(link[2])) {
        out.push(<ExternalLink key={key++} href={link[2]}>{link[1]}</ExternalLink>);
      } else {
        out.push(raw);
      }
    } else if (m[6]) {
      out.push(<ExternalLink key={key++} href={raw}>{raw.replace(/^https?:\/\//, '')}</ExternalLink>);
    } else if (m[7]) {
      const handle = raw.slice(1).toLowerCase();
      const isSelf = ctx.selfHandle && handle === ctx.selfHandle.toLowerCase();
      out.push(
        <button
          key={key++}
          className={`mention${isSelf ? ' mention--self' : ''}`}
          onClick={() => ctx.onMention?.(handle)}
        >{raw}</button>,
      );
    } else if (m[8]) {
      out.push(
        <button key={key++} className="mention" onClick={() => ctx.onChannel?.(raw.slice(1))}>{raw}</button>,
      );
    }
    last = index + raw.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        // Im Desktop-Fenster nie navigieren — immer im Systembrowser öffnen.
        e.preventDefault();
        if (window.stellium) void window.stellium.openExternal(href);
        else window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >{children}</a>
  );
}
