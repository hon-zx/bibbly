import { useEffect, useState } from 'react';
import type { AccountSettings, ConnectedAccount, NoteTarget, SyncStatus } from '@bibbly/connectors';
import type { TaskList } from '@bibbly/core';
import { cancelConnect, connectApp, disconnectApp, noteTargets, refreshConnectors, syncNow, updateAccountSettings, useApp } from '../store';
import type { ProviderView } from '../shared/ipc';
import { Seg, Toggle, fmtTime, relDay } from '../ui/bits';
import { Icon } from '../ui/Icon';

const MEETING: Record<string, string> = { google: 'Google Meet', microsoft: 'Teams', lark: 'Lark meeting' };

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${relDay(at).toLowerCase()} at ${fmtTime(at)}`;
}

function statusText(st: SyncStatus | undefined, syncing: boolean): string {
  if (syncing) return 'Syncing…';
  if (!st) return 'Not synced yet';
  if (!st.ok) return st.message ?? 'Sync failed.';
  const n = st.pulled + st.pushed + st.removed;
  return `Synced ${ago(st.at)}${n ? ` · ${n} ${n === 1 ? 'change' : 'changes'}` : ''}`;
}

const needsReconnect = (st?: SyncStatus) => !!st && !st.ok && /connect (it |\w+ )?again|reconnect|isn.t connected/i.test(st.message ?? '');

/** Settings: connect Google, Microsoft 365, Slack, Notion and Lark, and choose what syncs. */
export function ConnectedApps() {
  const { connectors: v, secrets } = useApp();
  useEffect(() => { void refreshConnectors(); }, []);
  if (!v) return null;
  const syncs = v.accounts.some(a => a.settings.calendar?.enabled || a.settings.tasks?.enabled);
  return (
    <section className="card form-card apps" aria-labelledby="apps-h">
      <div className="apps-head">
        <div><h2 className="h3" id="apps-h">Connected apps</h2>
          <p className="hint">Tasks and calendar sync both ways every few minutes. Notes go to a channel, page or folder when you send them, or after every meeting.</p></div>
        {syncs && <button className="btn sm" onClick={() => void syncNow()} disabled={v.syncing}><Icon n="refresh" />{v.syncing ? 'Syncing…' : 'Sync now'}</button>}
      </div>
      {secrets?.backend === 'basic_text' && <p className="hint warn-text"><Icon n="lock" size={14} /> No keyring found on this computer, so sign-ins are stored obfuscated rather than encrypted. Install GNOME Keyring or KWallet for real encryption.</p>}
      <ul className="app-list">{v.providers.map(p => <ProviderRow key={p.id} p={p} />)}</ul>
    </section>
  );
}

function ProviderRow({ p }: { p: ProviderView }) {
  const { connectors: v } = useApp();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const accounts = v!.accounts.filter(a => a.provider === p.id);
  const waiting = v!.connecting === p.id;
  const signIn = p.methods.includes('loopback') || p.methods.includes('broker');
  const does = p.capabilities.map(c => p.labels[c]).filter(Boolean).join(' · ');
  return (
    <li className="app" data-provider={p.id}>
      <div className="app-head">
        <span className={`app-logo ${p.id}`} aria-hidden="true">{p.name[0]}</span>
        <div className="app-title"><b>{p.name}</b>{p.beta && <span className="chip sm">Beta</span>}<span className="hint">{does}</span></div>
        <div className="app-actions">
          {waiting
            ? <><span className="chip sm"><span className="pulse" />Finish signing in in your browser</span><button className="btn sm ghost" onClick={() => void cancelConnect()}>Cancel</button></>
            : <>
              {signIn && <button className="btn sm" onClick={() => void connectApp(p.id)}>{accounts.length ? 'Add another' : 'Connect'}</button>}
              {p.methods.includes('token') && <button className="btn sm ghost" aria-expanded={tokenOpen} onClick={() => setTokenOpen(!tokenOpen)}><Icon n="key" />Token</button>}
            </>}
        </div>
      </div>
      {!signIn && !accounts.length && (
        <p className="hint">{v!.server.reachable === false ? `Signing in to ${p.name} needs the Bibbly server, which isn’t reachable at ${v!.server.url}.` : `Your Bibbly server isn’t set up for ${p.name} yet (see docs/connectors.md).`}
          {p.methods.includes('token') ? ' You can paste a token instead.' : ''}</p>
      )}
      {tokenOpen && (
        <form className="row nowrap token-row" onSubmit={e => { e.preventDefault(); void connectApp(p.id, token).then(() => { setToken(''); setTokenOpen(false); }); }}>
          <input className="input" type="password" autoComplete="off" aria-label={`${p.name} token`} placeholder={p.tokenHint} value={token} onChange={e => setToken(e.target.value)} />
          <button className="btn sm primary" type="submit" disabled={!token.trim()}>Connect</button>
        </form>
      )}
      {accounts.map(a => <AccountRow key={a.id} a={a} p={p} />)}
    </li>
  );
}

function AccountRow({ a, p }: { a: ConnectedAccount; p: ProviderView }) {
  const { connectors: v } = useApp();
  const st = v!.status[a.id];
  const [confirm, setConfirm] = useState(false);
  const [targets, setTargets] = useState<NoteTarget[] | null>(null);
  const { calendar: cal, tasks, notes } = a.settings;
  const set = (patch: Partial<AccountSettings>) => void updateAccountSettings(a.id, { ...a.settings, ...patch });
  const loadTargets = async () => setTargets(await noteTargets(a.id));
  const via = a.method === 'token' ? 'token' : a.method === 'broker' ? 'Bibbly server' : 'this computer';
  return (
    <div className="acct">
      <div className="acct-head">
        <div className="acct-who"><b>{a.label}</b><span className={`acct-status${st && !st.ok ? ' bad' : ''}`} role="status">{(cal || tasks) ? statusText(st, v!.syncing) : `Connected via ${via}`}</span></div>
        {needsReconnect(st) && <button className="btn sm" onClick={() => void connectApp(a.provider)}>Reconnect</button>}
        {confirm
          ? <span className="row nowrap"><button className="btn sm danger" onClick={() => void disconnectApp(a.id)}>Disconnect</button><button className="btn sm ghost" onClick={() => setConfirm(false)}>Keep</button></span>
          : <button className="btn sm ghost" onClick={() => setConfirm(true)}>Disconnect</button>}
      </div>
      {cal && (
        <div className="row-between">
          <div><b>{p.labels.calendar}</b><p className="hint">Your meetings for the next 30 days appear in Bibbly’s calendar{cal.calendarName ? ` (${cal.calendarName})` : ''}.</p>
            {cal.enabled && <label className="check-row"><input type="checkbox" checked={cal.push} onChange={e => set({ calendar: { ...cal, push: e.target.checked } })} />Save follow-ups made in Bibbly here{MEETING[p.id] ? `, with a ${MEETING[p.id]} link` : ''}</label>}</div>
          <Toggle on={cal.enabled} onChange={on => set({ calendar: { ...cal, enabled: on } })} label={`Sync ${p.labels.calendar}`} />
        </div>
      )}
      {tasks && (
        <div className="row-between">
          <div><b>{p.labels.tasks}</b><p className="hint">Two-way with the “{tasks.listName}” list. Tasks you add there land in:</p>
            {tasks.enabled && <Seg small label={`Bibbly list for tasks from ${p.name}`} value={tasks.localList} onChange={(l: TaskList) => set({ tasks: { ...tasks, localList: l } })}
              options={(['Work', 'Personal', 'Home'] as const).map(k => ({ value: k, label: k }))} />}</div>
          <Toggle on={tasks.enabled} onChange={on => set({ tasks: { ...tasks, enabled: on } })} label={`Sync ${p.labels.tasks}`} />
        </div>
      )}
      {notes && (
        <div className="row-between">
          <div className="grow"><b>{p.labels.notes}</b>
            {p.id === 'google'
              ? <p className="hint">Notes are saved as Google Docs in a “Bibbly notes” folder in your Drive.</p>
              : targets
                ? <span className="select"><select aria-label={`Where ${p.name} notes go`} value={notes.target?.id ?? ''} onChange={e => { const t = targets.find(x => x.id === e.target.value); if (t) set({ notes: { ...notes, target: t } }); }}>
                    <option value="" disabled>Choose where notes go…</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><Icon n="down" size={16} /></span>
                : <p className="hint">{notes.target ? <>Notes go to <b>{notes.target.name}</b>. </> : 'Choose where notes go. '}<button className="link" onClick={() => void loadTargets()}>{notes.target ? 'Change' : 'Choose'}</button></p>}
            {(notes.target || p.id === 'google') && <label className="check-row"><input type="checkbox" checked={notes.auto} onChange={e => set({ notes: { ...notes, auto: e.target.checked } })} />Send every note when a meeting ends</label>}
          </div>
        </div>
      )}
    </div>
  );
}
