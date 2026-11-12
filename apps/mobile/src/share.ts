/** Shares a note as a file through the system share sheet (Teams, Slack, Notion, Lark, mail, Files...). */
import { buildExport, type ExportFormat, type LangCode, type Note } from '@bibbly/core';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getData } from './store';

export const SHARE_FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: 'docx', label: 'Word document', detail: 'Notes and transcript, for Teams, Word and Google Docs' },
  { id: 'md', label: 'Markdown', detail: 'Pastes cleanly into Notion, Slack and Lark' },
  { id: 'txt', label: 'Plain text', detail: 'Anywhere' },
  { id: 'srt', label: 'Subtitles (SRT)', detail: 'For a recording of the meeting' },
];

export async function shareNote(note: Note, format: ExportFormat, lang: LangCode): Promise<void> {
  const { filename, data, mime } = buildExport(note, format, lang, { original: true, clarity: true, myName: getData().settings.myName });
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  await file.write(data);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: note.title });
}
