import { strToU8, zipSync } from 'fflate';
import { fmtStamp, hasTime } from '../dates.js';
import { detectedLabel, langName, langTag, spokenName } from '../lang.js';
import type { ClarityItem, LangCode, Line, Note } from '../types.js';

const LABELS: Record<string, Record<'summary' | 'decisions' | 'actions' | 'followup' | 'transcript', string>> = {
  en: { summary: 'Summary', decisions: 'Decisions', actions: 'Action items', followup: 'Follow-up meeting', transcript: 'Transcript' },
  zh: { summary: '摘要', decisions: '决定', actions: '待办事项', followup: '后续会议', transcript: '会议记录' },
  'zh-Hant': { summary: '摘要', decisions: '決定', actions: '待辦事項', followup: '後續會議', transcript: '會議記錄' },
  ja: { summary: '要約', decisions: '決定事項', actions: 'アクションアイテム', followup: 'フォローアップ会議', transcript: '議事録' },
};
export const clarityLabel = (lang: LangCode, key: keyof (typeof LABELS)['en']): string => (LABELS[lang] ?? LABELS.en!)[key];

/** Text of a clarity item in `lang`, falling back to its source language. */
export function itemText(item: ClarityItem, lang: LangCode): { text: string; fallback: boolean } {
  const t = item.text[lang];
  if (t) return { text: t, fallback: false };
  return { text: item.text[item.src] ?? Object.values(item.text)[0] ?? '', fallback: true };
}

/** Translation of a line into `lang`, or the original when it is already in that language. */
export function lineText(line: Line, lang: LangCode): { text: string; same: boolean; missing: boolean } {
  const mixed = !!line.langs && line.langs.length > 1;
  if (line.lang === lang && !mixed) return { text: line.text, same: true, missing: false };
  const t = line.tr[lang];
  return t ? { text: t, same: false, missing: false } : { text: line.text, same: false, missing: true };
}

export interface ExportOptions {
  /** Include the original language under each translated line. */
  original: boolean;
  /** Include summary, decisions, action items and follow-up. */
  clarity: boolean;
  /** Name used for the person exporting (replaces "You"). */
  myName?: string;
}

export interface ExportRow { start: number; end: number; speaker: string; detected: string; text: string; original: string | null; missing: boolean; }
export interface ExportModel {
  title: string;
  meta: string;
  lang: LangCode;
  rows: ExportRow[];
  clarity: { summary: string[]; decisions: string[]; actions: { owner: string; task: string; due: string }[]; followup: { title: string; when: string } | null } | null;
  missing: boolean;
}

function fmtDue(ms: number | null, lang: LangCode): string {
  if (!ms) return '';
  const opts: Intl.DateTimeFormatOptions = hasTime(ms)
    ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric' };
  return new Date(ms).toLocaleString(langTag(lang), opts);
}

export function exportModel(note: Note, lang: LangCode, opts: ExportOptions): ExportModel {
  const me = opts.myName || 'You';
  const rows = note.lines.map((l, i): ExportRow => {
    const g = lineText(l, lang);
    const next = note.lines[i + 1];
    const end = l.end ?? Math.max(l.t + 1.5, (next ? next.t : l.t + 6) - 0.2);
    return { start: l.t, end, speaker: l.speaker.self ? me : l.speaker.name, detected: detectedLabel(l.lang, l.langs),
             text: g.text, original: !g.same && opts.original ? l.text : null, missing: g.missing };
  });
  const cl = note.clarity;
  const clarity = opts.clarity && cl ? {
    summary: cl.summary.map(s => itemText(s, lang).text),
    decisions: cl.decisions.map(s => itemText(s, lang).text),
    actions: cl.actions.map(a => ({ owner: a.ownerIsMe ? me : a.owner, task: itemText(a, lang).text, due: fmtDue(a.due, lang) })),
    followup: cl.followup ? { title: itemText(cl.followup, lang).text, when: fmtDue(cl.followup.when, lang) } : null,
  } : null;
  const started = new Date(note.startedAt);
  const meta = [
    started.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    started.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }),
    `${Math.max(1, Math.round(note.durationSec / 60))} min`,
    note.source,
    `${note.languages.map(spokenName).join(', ')} → ${langName(lang)}`,
  ].join(' · ');
  return { title: note.title, meta, lang, rows, clarity, missing: rows.some(r => r.missing) };
}

export function toMarkdown(m: ExportModel): string {
  const out = [`# ${m.title}`, '', `_${m.meta}_`, ''];
  if (m.clarity) {
    if (m.clarity.summary.length) out.push(`## ${clarityLabel(m.lang, 'summary')}`, ...m.clarity.summary.map(s => `- ${s}`), '');
    if (m.clarity.decisions.length) out.push(`## ${clarityLabel(m.lang, 'decisions')}`, ...m.clarity.decisions.map(s => `- ${s}`), '');
    if (m.clarity.actions.length) out.push(`## ${clarityLabel(m.lang, 'actions')}`, ...m.clarity.actions.map(a => `- [ ] **${a.owner}**: ${a.task}${a.due ? ` (${a.due})` : ''}`), '');
    if (m.clarity.followup) out.push(`## ${clarityLabel(m.lang, 'followup')}`, `- ${m.clarity.followup.title}${m.clarity.followup.when ? `, ${m.clarity.followup.when}` : ''}`, '');
  }
  out.push(`## ${clarityLabel(m.lang, 'transcript')}`, '');
  for (const r of m.rows) {
    out.push(`**[${fmtStamp(r.start)}] ${r.speaker}** · ${r.detected}  `, r.text);
    if (r.original) out.push('', `> ${r.original}`);
    out.push('');
  }
  out.push('---', 'Captured and translated by Bibbly');
  return out.join('\n');
}

export function toText(m: ExportModel): string {
  const out = [m.title, m.meta, ''];
  if (m.clarity) {
    if (m.clarity.summary.length) out.push(clarityLabel(m.lang, 'summary').toUpperCase(), ...m.clarity.summary.map(s => `• ${s}`), '');
    if (m.clarity.decisions.length) out.push(clarityLabel(m.lang, 'decisions').toUpperCase(), ...m.clarity.decisions.map(s => `• ${s}`), '');
    if (m.clarity.actions.length) out.push(clarityLabel(m.lang, 'actions').toUpperCase(), ...m.clarity.actions.map(a => `☐ ${a.owner}: ${a.task}${a.due ? ` (${a.due})` : ''}`), '');
  }
  out.push(clarityLabel(m.lang, 'transcript').toUpperCase(), '');
  for (const r of m.rows) {
    out.push(`[${fmtStamp(r.start)}] ${r.speaker} (${r.detected})`, r.text);
    if (r.original) out.push(`  ↳ ${r.original}`);
    out.push('');
  }
  return out.join('\n');
}

const srtTime = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export const toSrt = (m: ExportModel): string =>
  m.rows.map((r, i) => `${i + 1}\n${srtTime(r.start)} --> ${srtTime(r.end)}\n${r.speaker}: ${r.text}${r.original ? `\n${r.original}` : ''}\n`).join('\n');
export const toVtt = (m: ExportModel): string =>
  'WEBVTT\n\n' + m.rows.map(r => `${srtTime(r.start).replace(',', '.')} --> ${srtTime(r.end).replace(',', '.')}\n<v ${r.speaker.replace(/[<>]/g, '')}>${r.text}${r.original ? `\n${r.original}` : ''}\n`).join('\n');

export function toJson(m: ExportModel, note: Note): string {
  return JSON.stringify({
    app: 'Bibbly', version: 1, title: m.title, startedAt: new Date(note.startedAt).toISOString(), durationSeconds: note.durationSec,
    outputLanguage: m.lang, spokenLanguages: note.languages, clarity: m.clarity,
    segments: m.rows.map(r => ({ start: r.start, end: r.end, speaker: r.speaker, detectedLanguage: r.detected, text: r.text, original: r.original })),
  }, null, 2);
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
interface RunOpts { b?: boolean; i?: boolean; color?: string; sz?: number }
const run = (text: string, o: RunOpts = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
const para = (runs: string, o: { after?: number; ind?: number } = {}) => `<w:p><w:pPr>${o.after != null ? `<w:spacing w:after="${o.after}"/>` : ''}${o.ind ? `<w:ind w:left="${o.ind}"/>` : ''}</w:pPr>${runs}</w:p>`;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Word document (.docx) for Teams, Google Docs and Lark Docs. */
export function toDocx(m: ExportModel): Uint8Array {
  const b: string[] = [para(run(m.title, { b: true, sz: 36 }), { after: 80 }), para(run(m.meta, { color: '5A6F6B', sz: 20 }), { after: 240 })];
  const h = (t: string) => b.push(para(run(t, { b: true, sz: 26, color: '0A7A69' }), { after: 100 }));
  const bullet = (t: string) => b.push(para(run(`•  ${t}`), { ind: 360, after: 60 }));
  if (m.clarity) {
    if (m.clarity.summary.length) { h(clarityLabel(m.lang, 'summary')); m.clarity.summary.forEach(bullet); }
    if (m.clarity.decisions.length) { h(clarityLabel(m.lang, 'decisions')); m.clarity.decisions.forEach(bullet); }
    if (m.clarity.actions.length) {
      h(clarityLabel(m.lang, 'actions'));
      for (const a of m.clarity.actions) b.push(para(run('☐  ') + run(`${a.owner}: `, { b: true }) + run(a.task + (a.due ? ` (${a.due})` : '')), { ind: 360, after: 60 }));
    }
    if (m.clarity.followup) { h(clarityLabel(m.lang, 'followup')); bullet(`${m.clarity.followup.title}${m.clarity.followup.when ? `, ${m.clarity.followup.when}` : ''}`); }
  }
  h(clarityLabel(m.lang, 'transcript'));
  for (const r of m.rows) {
    b.push(para(run(`[${fmtStamp(r.start)}]  `, { color: '7A928D', sz: 18 }) + run(r.speaker, { b: true }) + run(`  ·  ${r.detected}`, { color: '7A928D', sz: 18 }), { after: 20 }));
    b.push(para(run(r.text), { after: r.original ? 20 : 160 }));
    if (r.original) b.push(para(run(r.original, { i: true, color: '5A6F6B', sz: 20 }), { ind: 240, after: 160 }));
  }
  b.push(para(run('Captured and translated by Bibbly', { i: true, color: '7A928D', sz: 18 })));
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipSync({
    '[Content_Types].xml': strToU8(`${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'word/document.xml': strToU8(`${xml}<w:document xmlns:w="${W}"><w:body>${b.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    'word/styles.xml': strToU8(`${xml}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`),
  });
}

export type ExportFormat = 'docx' | 'md' | 'txt' | 'srt' | 'vtt' | 'json' | 'subtitles-zip' | 'all-zip';

export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'bibbly-notes';

/** Builds one export file. Returns its suggested filename and bytes. */
export function buildExport(note: Note, format: ExportFormat, lang: LangCode, opts: ExportOptions): { filename: string; data: Uint8Array; mime: string } {
  const m = exportModel(note, lang, opts);
  const base = `${slugify(note.title)}-${lang}`;
  const text = (s: string) => strToU8(s);
  switch (format) {
    case 'docx': return { filename: `${base}.docx`, data: toDocx(m), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    case 'md': return { filename: `${base}.md`, data: text(toMarkdown(m)), mime: 'text/markdown' };
    case 'txt': return { filename: `${base}.txt`, data: text(toText(m)), mime: 'text/plain' };
    case 'srt': return { filename: `${base}.srt`, data: text(toSrt(m)), mime: 'application/x-subrip' };
    case 'vtt': return { filename: `${base}.vtt`, data: text(toVtt(m)), mime: 'text/vtt' };
    case 'json': return { filename: `${base}.json`, data: text(toJson(m, note)), mime: 'application/json' };
    case 'subtitles-zip':
      return { filename: `${base}-subtitles.zip`, data: zipSync({ [`${base}.srt`]: text(toSrt(m)), [`${base}.vtt`]: text(toVtt(m)) }), mime: 'application/zip' };
    case 'all-zip':
      return {
        filename: `${base}-all.zip`, mime: 'application/zip',
        data: zipSync({ [`${base}.docx`]: toDocx(m), [`${base}.md`]: text(toMarkdown(m)), [`${base}.txt`]: text(toText(m)),
                        [`${base}.srt`]: text(toSrt(m)), [`${base}.vtt`]: text(toVtt(m)), [`${base}.json`]: text(toJson(m, note)) }),
      };
  }
}
