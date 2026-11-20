/**
 * Turns a note into each connected app's format, from the same model as the
 * file exports (packages/core/src/export), so a note reads the same everywhere:
 * Clarity notes first (summary, decisions, action items, follow-up), then the
 * transcript in the reader's language with the original underneath.
 */
import { clarityLabel, exportModel, fmtStamp, toMarkdown, type ExportModel, type Note } from '@bibbly/core';
import type { PublishOptions } from './types.js';
import { chunkText, clip } from './util.js';

export function noteModel(note: Note, opts: PublishOptions): ExportModel {
  return exportModel(note, opts.lang, { original: true, clarity: true, ...(opts.myName ? { myName: opts.myName } : {}) });
}

export const noteMarkdown = (m: ExportModel): string => toMarkdown(m);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function actionLine(a: { owner: string; task: string; due: string }): string {
  return `${a.owner}: ${a.task}${a.due ? ` (${a.due})` : ''}`;
}

/** HTML for Google Docs and Teams. `maxRows` keeps chat messages inside size limits. */
export function noteHtml(m: ExportModel, opts: { maxRows?: number; heading?: boolean } = {}): string {
  const out: string[] = [];
  if (opts.heading !== false) out.push(`<h1>${esc(m.title)}</h1>`);
  out.push(`<p><i>${esc(m.meta)}</i></p>`);
  const c = m.clarity;
  const list = (items: string[]) => `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  if (c) {
    if (c.summary.length) out.push(`<h2>${esc(clarityLabel(m.lang, 'summary'))}</h2>`, list(c.summary));
    if (c.decisions.length) out.push(`<h2>${esc(clarityLabel(m.lang, 'decisions'))}</h2>`, list(c.decisions));
    if (c.actions.length) out.push(`<h2>${esc(clarityLabel(m.lang, 'actions'))}</h2>`, `<ul>${c.actions.map(a => `<li>☐ <b>${esc(a.owner)}</b>: ${esc(a.task)}${a.due ? ` (${esc(a.due)})` : ''}</li>`).join('')}</ul>`);
    if (c.followup) out.push(`<h2>${esc(clarityLabel(m.lang, 'followup'))}</h2>`, `<p>${esc(c.followup.title)}${c.followup.when ? `, ${esc(c.followup.when)}` : ''}</p>`);
  }
  const rows = opts.maxRows != null ? m.rows.slice(0, opts.maxRows) : m.rows;
  if (rows.length) {
    out.push(`<h2>${esc(clarityLabel(m.lang, 'transcript'))}</h2>`);
    for (const r of rows) {
      out.push(`<p><b>[${fmtStamp(r.start)}] ${esc(r.speaker)}</b> · ${esc(r.detected)}<br>${esc(r.text)}${r.original ? `<br><i>${esc(r.original)}</i>` : ''}</p>`);
    }
    if (rows.length < m.rows.length) out.push(`<p><i>${m.rows.length - rows.length} more lines in Bibbly.</i></p>`);
  }
  out.push('<p><i>Captured and translated by Bibbly</i></p>');
  return out.join('\n');
}

/* ---- Slack (Block Kit) ---- */

const slackEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(m: ExportModel): { text: string; blocks: Record<string, unknown>[] } {
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(m.title, 150)!, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: slackEsc(clip(m.meta, 300)!) }] },
  ];
  const section = (label: string, lines: string[]) => {
    if (!lines.length) return;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*${slackEsc(label)}*\n${lines.join('\n')}`, 2900)! } });
  };
  const c = m.clarity;
  if (c) {
    section(clarityLabel(m.lang, 'summary'), c.summary.map(s => `• ${slackEsc(s)}`));
    section(clarityLabel(m.lang, 'decisions'), c.decisions.map(s => `• ${slackEsc(s)}`));
    section(clarityLabel(m.lang, 'actions'), c.actions.map(a => `☐ *${slackEsc(a.owner)}*: ${slackEsc(a.task)}${a.due ? ` _(${slackEsc(a.due)})_` : ''}`));
    if (c.followup) section(clarityLabel(m.lang, 'followup'), [`${slackEsc(c.followup.title)}${c.followup.when ? `, ${slackEsc(c.followup.when)}` : ''}`]);
  }
  if (!c || (!c.summary.length && !c.actions.length)) {
    section(clarityLabel(m.lang, 'transcript'), m.rows.slice(0, 12).map(r => `*${slackEsc(r.speaker)}*: ${slackEsc(r.text)}`));
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Captured and translated by Bibbly · full transcript attached' }] });
  const text = [m.title, ...(c?.summary ?? []).slice(0, 3).map(s => `• ${s}`)].join('\n');
  return { text: clip(text, 3000)!, blocks: blocks.slice(0, 50) };
}

/* ---- Notion blocks ---- */

type RichText = { type: 'text'; text: { content: string }; annotations?: { bold?: boolean; italic?: boolean } };

const rich = (s: string, annotations?: RichText['annotations']): RichText[] =>
  chunkText(s, 2000).map(content => ({ type: 'text' as const, text: { content }, ...(annotations ? { annotations } : {}) }));

const block = (type: string, body: Record<string, unknown>) => ({ object: 'block', type, [type]: body });

export function notionBlocks(m: ExportModel): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [block('paragraph', { rich_text: rich(m.meta, { italic: true }) })];
  const c = m.clarity;
  if (c) {
    if (c.summary.length) out.push(block('heading_2', { rich_text: rich(clarityLabel(m.lang, 'summary')) }), ...c.summary.map(s => block('bulleted_list_item', { rich_text: rich(s) })));
    if (c.decisions.length) out.push(block('heading_2', { rich_text: rich(clarityLabel(m.lang, 'decisions')) }), ...c.decisions.map(s => block('bulleted_list_item', { rich_text: rich(s) })));
    if (c.actions.length) out.push(block('heading_2', { rich_text: rich(clarityLabel(m.lang, 'actions')) }), ...c.actions.map(a => block('to_do', { rich_text: rich(actionLine(a)), checked: false })));
    if (c.followup) out.push(block('heading_2', { rich_text: rich(clarityLabel(m.lang, 'followup')) }), block('paragraph', { rich_text: rich(`${c.followup.title}${c.followup.when ? `, ${c.followup.when}` : ''}`) }));
  }
  if (m.rows.length) {
    out.push(block('divider', {}), block('heading_2', { rich_text: rich(clarityLabel(m.lang, 'transcript')) }));
    for (const r of m.rows) {
      out.push(block('paragraph', { rich_text: [...rich(`[${fmtStamp(r.start)}] ${r.speaker} · ${r.detected}\n`, { bold: true }), ...rich(r.text)] }));
      if (r.original) out.push(block('quote', { rich_text: rich(r.original) }));
    }
  }
  return out;
}

/* ---- Lark rich-text post ---- */

type LarkEl = { tag: 'text'; text: string; style?: string[] };

export function larkPost(m: ExportModel, maxRows = 30): Record<string, unknown> {
  const content: LarkEl[][] = [[{ tag: 'text', text: m.meta }]];
  const add = (label: string, lines: string[]) => {
    if (!lines.length) return;
    content.push([{ tag: 'text', text: label, style: ['bold'] }], ...lines.map(l => [{ tag: 'text' as const, text: l }]));
  };
  const c = m.clarity;
  if (c) {
    add(clarityLabel(m.lang, 'summary'), c.summary.map(s => `• ${s}`));
    add(clarityLabel(m.lang, 'decisions'), c.decisions.map(s => `• ${s}`));
    add(clarityLabel(m.lang, 'actions'), c.actions.map(a => `☐ ${actionLine(a)}`));
    if (c.followup) add(clarityLabel(m.lang, 'followup'), [`${c.followup.title}${c.followup.when ? `, ${c.followup.when}` : ''}`]);
  }
  const rows = m.rows.slice(0, maxRows);
  add(clarityLabel(m.lang, 'transcript'), rows.map(r => `[${fmtStamp(r.start)}] ${r.speaker}: ${r.text}`));
  if (rows.length < m.rows.length) content.push([{ tag: 'text', text: `${m.rows.length - rows.length} more lines in Bibbly.` }]);
  return { en_us: { title: clip(m.title, 100), content } };
}
