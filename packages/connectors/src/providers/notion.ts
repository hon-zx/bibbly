/** Notion: each note becomes a page under a page the user shared with Bibbly. */
import type { Note } from '@bibbly/core';
import { noteModel, notionBlocks } from '../format.js';
import type { NotesApi, NoteTarget, Profile, PublishOptions, TokenSet } from '../types.js';
import { clip } from '../util.js';
import type { ApiCtx } from './ctx.js';

/** Latest Notion API version (2026-03-11 renamed archived to in_trash; page creation is unchanged). */
export const NOTION_VERSION = '2026-03-11';
const H = { 'Notion-Version': NOTION_VERSION };

interface NPage { id: string; url?: string; properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }> }

function pageTitle(p: NPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop.type === 'title') return (prop.title ?? []).map(t => t.plain_text ?? '').join('').trim() || 'Untitled';
  }
  return 'Untitled';
}

export function notionPages(ctx: ApiCtx): NotesApi {
  return {
    async listTargets(): Promise<NoteTarget[]> {
      const out: NoteTarget[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 4; i++) {
        const res = await ctx.http.request<{ results?: NPage[]; has_more?: boolean; next_cursor?: string | null }>({
          method: 'POST', url: `${ctx.ep.notionApi}/search`, auth: ctx.auth, headers: H,
          json: { filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        });
        for (const p of res.results ?? []) out.push({ id: p.id, name: pageTitle(p), detail: 'Notion page' });
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return out;
    },
    async publish(target, note: Note, opts: PublishOptions) {
      const m = noteModel(note, opts);
      const blocks = notionBlocks(m);
      const page = await ctx.http.request<{ id: string; url?: string }>({
        method: 'POST', url: `${ctx.ep.notionApi}/pages`, auth: ctx.auth, headers: H,
        json: {
          parent: { page_id: target.id },
          properties: { title: { title: [{ type: 'text', text: { content: clip(m.title, 2000) } }] } },
          children: blocks.slice(0, 100),
        },
      });
      // Notion takes at most 100 blocks per request: append the rest in order.
      for (let i = 100; i < blocks.length; i += 100) {
        await ctx.http.request({ method: 'PATCH', url: `${ctx.ep.notionApi}/blocks/${encodeURIComponent(page.id)}/children`, auth: ctx.auth, headers: H, json: { children: blocks.slice(i, i + 100) } });
      }
      return page.url ? { url: page.url } : {};
    },
  };
}

export async function notionProfile(tokens: TokenSet, ctx: ApiCtx): Promise<Profile> {
  if (tokens.extra?.workspace_name) return { id: tokens.extra.workspace_id ?? tokens.extra.workspace_name, label: `${tokens.extra.workspace_name} (Notion)` };
  const me = await ctx.http.request<{ id: string; name?: string; bot?: { workspace_name?: string } }>({ url: `${ctx.ep.notionApi}/users/me`, auth: ctx.auth, headers: H });
  const ws = me.bot?.workspace_name;
  return { id: ws ?? me.id, label: ws ? `${ws} (Notion)` : me.name ?? 'Notion workspace' };
}
