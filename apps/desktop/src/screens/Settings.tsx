import { useEffect, useState } from 'react';
import { langNative, type LangCode } from '@bibbly/core';
import { api } from '../api';
import { saveSettings, setState, toast, useApp } from '../store';
import type { SecretName } from '../shared/ipc';
import { LangSelect, OUT_LANGS, Seg, Toggle } from '../ui/bits';
import { Icon } from '../ui/Icon';

export function SettingsScreen() {
  const { data, secrets } = useApp();
  const [glossary, setGlossary] = useState('');
  useEffect(() => { if (data) setGlossary(data.settings.glossary.join(', ')); }, [data?.settings.glossary]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || !secrets) return null;
  const s = data.settings;
  const toggleSpeaking = (code: LangCode) => {
    const has = s.speaking.includes(code);
    if (has && s.speaking.length === 1) return;
    void saveSettings({ speaking: has ? s.speaking.filter(c => c !== code) : [...s.speaking, code] });
  };
  return (
    <div className="page settings">
      <header className="page-head"><div><h1 className="h1">Settings</h1><p className="lede">Languages, speech engine, Claude and sharing. Keys are encrypted with your system keychain ({secrets.backend}).</p></div></header>

      <section className="card form-card">
        <h2 className="h3">You</h2>
        <div className="field-row">
          <div className="field"><label htmlFor="st-name">Your name</label><input id="st-name" className="input" defaultValue={s.myName} onBlur={e => void saveSettings({ myName: e.target.value.trim() || 'You' })} /></div>
          <div className="field"><label htmlFor="st-lang">My caption language</label><LangSelect id="st-lang" value={s.myLang} onChange={v => void saveSettings({ myLang: v })} label="My caption language" /></div>
        </div>
        <div className="field"><span className="flabel">Languages people speak in your meetings</span>
          <div className="chips">{OUT_LANGS.map(l => (
            <button key={l.code} type="button" className={`fchip${s.speaking.includes(l.code) ? ' on' : ''}`} aria-pressed={s.speaking.includes(l.code)} onClick={() => toggleSpeaking(l.code)} lang={l.tag}>{l.native}</button>))}</div>
          <p className="hint">Azure uses these to detect each speaker’s language (up to 10). Whisper servers detect any language by themselves.</p></div>
      </section>

      <section className="card form-card">
        <h2 className="h3">Speech engine</h2>
        <Seg label="Speech engine" value={s.engine} onChange={v => void saveSettings({ engine: v })}
          options={[{ value: 'demo', label: 'Demo only' }, { value: 'azure', label: 'Azure AI Speech' }, { value: 'whisper', label: 'Whisper server' }]} />
        {s.engine === 'demo' && <p className="hint">Plays the demo meeting. Pick an engine to caption real audio.</p>}
        {s.engine === 'azure' && (
          <>
            <p className="hint">Continuous language detection: Bibbly follows each speaker as they move between {s.speaking.slice(0, 3).map(langNative).join(', ')}.</p>
            <div className="field-row">
              <SecretField name="azureKey" label="Azure Speech key" set={secrets.azureKey} />
              <div className="field"><label htmlFor="st-region">Region</label><input id="st-region" className="input" defaultValue={s.azureRegion} placeholder="e.g. southeastasia" onBlur={e => void saveSettings({ azureRegion: e.target.value.trim() })} /></div>
            </div>
          </>
        )}
        {s.engine === 'whisper' && (
          <>
            <p className="hint">Any server with the /v1/audio/transcriptions endpoint: a local faster-whisper or whisper.cpp server keeps audio on this computer.</p>
            <div className="field-row">
              <div className="field"><label htmlFor="st-wurl">Server address</label><input id="st-wurl" className="input" defaultValue={s.whisperUrl} onBlur={e => void saveSettings({ whisperUrl: e.target.value.trim() })} /></div>
              <SecretField name="whisperKey" label="API key (if the server needs one)" set={secrets.whisperKey} />
            </div>
          </>
        )}
      </section>

      <section className="card form-card">
        <h2 className="h3">Claude: translation and notes</h2>
        <div className="field-row">
          <SecretField name="anthropicKey" label="Anthropic API key" set={secrets.anthropicKey} hint={secrets.envAnthropic && !secrets.anthropicKey ? 'Using ANTHROPIC_API_KEY from your environment.' : undefined} />
          <div className="field"><label htmlFor="st-model">Model</label><input id="st-model" className="input" defaultValue={s.claudeModel} onBlur={e => void saveSettings({ claudeModel: e.target.value.trim() || 'claude-opus-5-5' })} />
            <p className="hint">Default claude-opus-5-5. Live captions use low effort for speed; final notes use high effort.</p></div>
        </div>
        <div className="row-between"><div><b>Fast mode</b><p className="hint">Faster translations at premium pricing. Off by default.</p></div><Toggle on={s.fastMode} onChange={v => void saveSettings({ fastMode: v })} label="Fast mode" /></div>
        <div className="field"><label htmlFor="st-gloss">Glossary</label>
          <textarea id="st-gloss" className="input textarea" rows={2} value={glossary} onChange={e => setGlossary(e.target.value)}
            onBlur={() => void saveSettings({ glossary: glossary.split(/[,\n]/).map(x => x.trim()).filter(Boolean).slice(0, 100) })} />
          <p className="hint">Names and product terms Bibbly must keep exactly, e.g. Nimbus Lite, 李伟.</p></div>
      </section>

      <section className="card form-card">
        <h2 className="h3">Sharing</h2>
        <div className="field"><label htmlFor="st-room">Rooms server</label><input id="st-room" className="input" defaultValue={s.roomServer} onBlur={e => void saveSettings({ roomServer: e.target.value.trim().replace(/\/$/, '') })} />
          <p className="hint">Runs apps/server. Guests open the room link and pick their own language; the server translates once per language.</p></div>
      </section>

      <section className="card form-card">
        <h2 className="h3">Privacy</h2>
        <p className="hint"><Icon n="lock" size={14} /> Recordings, notes and keys stay on this computer. Audio goes only to the speech engine you chose, and text only to Claude for translation and notes. Let people know when you caption a meeting; some places require everyone’s consent to record.</p>
        <button className="btn ghost sm" onClick={() => setState({ route: 'notes' })}>Manage notes</button>
      </section>
    </div>
  );
}

function SecretField({ name, label, set, hint }: { name: SecretName; label: string; set: boolean; hint?: string | undefined }) {
  const [v, setV] = useState('');
  const save = async (value: string | null) => {
    try {
      const status = await api.secrets.set(name, value);
      setState({ secrets: status });
      setV('');
      toast(value ? 'Key saved and encrypted.' : 'Key removed.');
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not save the key.'); }
  };
  return (
    <div className="field"><label htmlFor={`sk-${name}`}>{label}</label>
      <div className="row nowrap">
        <input id={`sk-${name}`} className="input" type="password" autoComplete="off" placeholder={set ? 'Saved (hidden). Type to replace.' : 'Paste your key'} value={v} onChange={e => setV(e.target.value)} />
        <button className="btn sm" type="button" disabled={!v.trim()} onClick={() => void save(v)}><Icon n="key" />Save</button>
        {set && <button className="btn sm ghost" type="button" onClick={() => void save(null)}>Remove</button>}
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
