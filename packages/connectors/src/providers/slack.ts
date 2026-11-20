/** Slack: notes posted to a channel, with the full transcript attached in the thread. */
import type { Note } from '@bibbly/core';
import { ConnectorError } from '../http.js';
import { noteMarkdown, noteModel, slackMessage } from '../format.js';
import type { NotesApi, NoteTarget, Profile, PublishOptions } from '../types.js';
import { utf8Length } from '../util.js';
import type { ApiCtx } from './ctx.js';

type SlackResp = { ok: boolean; error?: string; [k: string]: unknown };

async function call<T extends SlackResp>(ctx: ApiCtx, method: string, args: { json?: Record<string, unknown>; query?: Record<string, string | number | boolean> }): Promise<T> {
  const res = await ctx.http.request<T>({
    method: args.json ? 'POST' : 'GET', url: `${ctx.ep.slackApi}/${method}`, auth: ctx.auth,
    ...(args.json ? { json: args.json, headers: { 'Content-Type': 'application/json; charset=utf-8' } } : {}),
    ...(args.query ? { query: args.query } : {}),
  });
  if (!res.ok) throw new ConnectorError(slackError(res.error), 'Slack', 200, res.error);
  return res;
}

function slackError(code?: string): string {
  switch (code) {
    case 'not_in_channel': return 'Bibbly is not in that Slack channel. Invite the Bibbly app to the channel, or pick another one.';
    case 'channel_not_found': return 'That Slack channel no longer exists, or Bibbly cannot see it.';
    case 'invalid_auth': case 'token_revoked': case 'account_inactive': return 'Slack no longer accepts Bibbly’s connection. Connect Slack again in Settings.';
    case 'missing_scope': return 'The Slack app is missing a permission. Reinstall it with the permissions listed in the Bibbly setup guide.';
    default: return `Slack said: ${code ?? 'unknown error'}`;
  }
}

export function slackChannels(ctx: ApiCtx): NotesApi {
  return {
    async listTargets(): Promise<NoteTarget[]> {
      const out: NoteTarget[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page++) {
        const res = await call<SlackResp & { channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
          ctx, 'conversations.list', { query: { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const c of res.channels ?? []) out.push({ id: c.id, name: `#${c.name}`, ...(c.is_private ? { detail: 'Private channel' } : {}) });
        cursor = res.response_metadata?.next_cursor ?? '';
        if (!cursor) break;
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async publish(target, note: Note, opts: PublishOptions) {
      const m = noteModel(note, opts);
      const msg = slackMessage(m);
      const post = () => call<SlackResp & { ts: string; channel: string }>(ctx, 'chat.postMessage', { json: { channel: target.id, text: msg.text, blocks: msg.blocks, unfurl_links: false, unfurl_media: false } });
      let posted: SlackResp & { ts: string; channel: string };
      try {
        posted = await post();
      } catch (err) {
        if ((err as ConnectorError).code !== 'not_in_channel') throw err;
        await call(ctx, 'conversations.join', { json: { channel: target.id } });
        posted = await post();
      }
      // Full transcript as a Markdown file in the thread (files v2 upload).
      try {
        const md = noteMarkdown(m);
        const filename = `${m.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'bibbly-notes'}.md`;
        const up = await call<SlackResp & { upload_url: string; file_id: string }>(ctx, 'files.getUploadURLExternal', { query: { filename, length: utf8Length(md) } });
        await ctx.http.request({ method: 'POST', url: up.upload_url, body: md, headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, expect: 'text' });
        await call(ctx, 'files.completeUploadExternal', { json: { files: [{ id: up.file_id, title: `${m.title} (transcript)` }], channel_id: posted.channel, thread_ts: posted.ts } });
      } catch (err) {
        if ((err as ConnectorError).code !== 'missing_scope') throw err; // the summary still went out
      }
      const link = await call<SlackResp & { permalink?: string }>(ctx, 'chat.getPermalink', { query: { channel: posted.channel, message_ts: posted.ts } }).catch(() => null);
      return link?.permalink ? { url: link.permalink } : {};
    },
  };
}

export async function slackProfile(ctx: ApiCtx): Promise<Profile> {
  const me = await call<SlackResp & { team?: string; team_id?: string; user?: string }>(ctx, 'auth.test', { json: {} });
  return { id: me.team_id ?? 'slack', label: me.team ? `${me.team} (Slack)` : 'Slack workspace' };
}
