/** Note helpers: translating a saved note into another language and turning action items into tasks. */
import { DemoTranslator, lineText, uid, type ActionItem, type LangCode, type Note, type Task } from '@bibbly/core';
import { claude } from './services';
import { getData, update } from './store';

/** Fills in missing translations for a saved note (lines and Clarity notes) and saves it. */
export async function translateNote(note: Note, lang: LangCode): Promise<Note> {
  const copy = JSON.parse(JSON.stringify(note)) as Note;
  const translator = new DemoTranslator(claude());
  const missing = copy.lines.filter(l => lineText(l, lang).missing);
  for (let i = 0; i < missing.length; i += 12) {
    const batch = missing.slice(i, i + 12);
    const res = await translator.translate({ target: lang, title: copy.title, items: batch.map(l => ({ id: l.id, text: l.text, speaker: l.speaker.name })) });
    for (const r of res) { const l = copy.lines.find(x => x.id === r.id); if (l) l.tr[lang] = r.translation; }
  }
  const c = copy.clarity;
  if (c) {
    const items = [...c.summary, ...c.decisions, ...c.actions, ...(c.followup ? [c.followup] : [])].filter(it => !it.text[lang]);
    if (items.length) {
      const res = await translator.translate({ target: lang, title: copy.title, items: items.map((it, i) => ({ id: String(i), text: it.text[it.src] ?? '' })) });
      for (const r of res) { const it = items[Number(r.id)]; if (it) it.text[lang] = r.translation; }
    }
  }
  update(d => ({ notes: d.notes.map(n => (n.id === copy.id ? copy : n)) }));
  return copy;
}

export function needsTranslation(note: Note, lang: LangCode): boolean {
  if (note.lines.some(l => lineText(l, lang).missing)) return true;
  const c = note.clarity;
  return !!c && [...c.summary, ...c.decisions, ...c.actions].some(it => !it.text[lang]);
}

export function actionInTasks(note: Note, a: ActionItem): boolean {
  return getData().tasks.some(t => t.source?.noteId === note.id && t.source.actionId === a.id);
}

export function addActionToTasks(note: Note, a: ActionItem, lang: LangCode): void {
  if (actionInTasks(note, a)) return;
  const task: Task = {
    id: uid('task-'), title: a.text[lang] ?? a.text[a.src] ?? Object.values(a.text)[0] ?? 'Follow up', list: 'Work', due: a.due, remind: a.due != null, done: false,
    source: { noteId: note.id, actionId: a.id, ...(a.lineId ? { lineId: a.lineId } : {}) },
  };
  update(d => ({ tasks: [task, ...d.tasks] }));
}

export function deleteNote(id: string): void {
  update(d => ({ notes: d.notes.filter(n => n.id !== id) }));
}
