import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildExport, exportModel, toMarkdown, toSrt, toVtt } from '../src/export/index.js';
import { demoNote } from './helpers.js';

/** Minimal XML well-formedness check: balanced tags, no stray "<" or "&". */
function wellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    if (m.index !== consumed) return false;
    consumed = re.lastIndex;
    if (m[5] !== undefined) { if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) return false; continue; }
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[4]) stack.push(m[2]!);
  }
  return consumed === body.length && stack.length === 0;
}

describe('exports', () => {
  const note = demoNote();
  it('writes Markdown in the chosen language with clarity and originals', () => {
    const md = toMarkdown(exportModel(note, 'zh', { original: true, clarity: true, myName: 'Alex' }));
    expect(md).toContain('## 摘要');
    expect(md).toContain('- [ ] **Li Wei**: 把包装文件发给佐藤');
    expect(md).toContain('**[00:00:19] Jun Lim** · English');
    expect(md).toContain('> Thanks, Li Wei.');
    expect(md).not.toMatch(/undefined|NaN/);
  });
  it('writes subtitles', () => {
    const m = exportModel(note, 'en', { original: false, clarity: false });
    expect(toSrt(m).split('\n').slice(0, 3)).toEqual(['1', '00:00:04,000 --> 00:00:18,800', "Li Wei: Hi everyone, let's get started. Today we mainly need to confirm the Nimbus Lite launch dates for Singapore and Japan."]);
    expect(toVtt(m).startsWith('WEBVTT\n\n00:00:04.000 --> 00:00:18.800\n<v Li Wei>')).toBe(true);
  });
  it('marks lines that have no translation yet', () => {
    expect(exportModel(note, 'es', { original: true, clarity: false }).missing).toBe(true);
  });
  it('builds a valid Word document', () => {
    const { filename, data } = buildExport(note, 'docx', 'ja', { original: true, clarity: true });
    expect(filename).toBe('q4-launch-sync-shanghai-singapore-tokyo-ja.docx');
    const files = unzipSync(data);
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    for (const [name, bytes] of Object.entries(files)) expect(wellFormed(strFromU8(bytes)), name).toBe(true);
    expect(strFromU8(files['word/document.xml']!)).toContain('皆さん、こんにちは');
  });
  it('bundles every format', () => {
    const files = unzipSync(buildExport(note, 'all-zip', 'en', { original: true, clarity: true }).data);
    expect(Object.keys(files).map(f => f.split('.').pop()).sort()).toEqual(['docx', 'json', 'md', 'srt', 'txt', 'vtt']);
    JSON.parse(strFromU8(files[Object.keys(files).find(f => f.endsWith('.json'))!]!));
  });
});
