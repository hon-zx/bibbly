import type { Task } from '@bibbly/core';
import { describe, expect, it } from 'vitest';
import { applySyncResult } from '../src/sync/merge.js';

const t = (id: string, title: string, extra: Partial<Task> = {}): Task => ({ id, title, list: 'Work', due: null, remind: false, done: false, ...extra });

describe('putting a sync result back', () => {
  it('keeps edits, additions and deletions made while the sync ran', () => {
    const before = { tasks: [t('a', 'A'), t('b', 'B'), t('c', 'C')], events: [] };
    // The sync imported a remote rename of A, linked B, and brought in R from the other app.
    const after = { tasks: [t('a', 'A (renamed in Google)'), t('b', 'B', { synced: [{ provider: 'google', accountId: 'google:x' }] }), t('c', 'C'), t('r', 'From Google')], events: [] };
    // Meanwhile the user renamed B, deleted C and added N. Objects are new copies (as after IPC), A unchanged.
    const current = { tasks: [{ ...t('a', 'A') }, t('b', 'B edited here', { updatedAt: 5 }), t('n', 'New')], events: [] };
    const out = applySyncResult(before, after, current).tasks;
    expect(out.map(x => x.title)).toEqual(['A (renamed in Google)', 'B edited here', 'From Google', 'New']);
    expect(out.find(x => x.id === 'b')!.synced).toEqual([{ provider: 'google', accountId: 'google:x' }]);
  });
});
