// Onboard subscription (docs/hosted-service.md step 4): an AVD Admin who owns the subscription lets AKC AVD Deploy
// build in one resource group. Every action is shown with its current state before anything changes.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, message, useApi, type Region, type Subscription } from '../api';

interface Action {
  id: string;
  title: string;
  detail: string;
  status: 'done' | 'todo' | 'in-progress' | 'blocked';
  message?: string;
}

interface Onboarded {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  scaling: boolean;
  onboardedBy: string;
  onboardedAt: string;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const marks: Record<Action['status'], [string, string]> = {
  done: ['✓', 'ok'],
  todo: ['•', ''],
  'in-progress': ['…', ''],
  blocked: ['!', 'bad'],
};

export function Onboard({ step, canOnboard, onRelink }: { step: number; canOnboard: boolean; onRelink: () => Promise<void> }) {
  const api = useApi();
  const [onboarded, setOnboarded] = useState<Onboarded[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [form, setForm] = useState({ subscriptionId: '', location: 'uksouth', resourceGroup: 'rg-avd', scaling: true });
  const [actions, setActions] = useState<Action[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const fail = useCallback(async (e: unknown) => {
    if (e instanceof ApiError && e.code === 'relink-needed') { await onRelink(); return; }
    setError(message(e));
  }, [onRelink]);

  const loadOnboarded = useCallback(async () => {
    try { setOnboarded((await api<{ onboardings: Onboarded[] }>('GET', '/onboarding')).onboardings); } catch (e) { await fail(e); }
  }, [api, fail]);

  useEffect(() => { void loadOnboarded(); }, [loadOnboarded]);

  useEffect(() => {
    if (!open || subscriptions.length) return;
    (async () => {
      try {
        const subs = (await api<{ subscriptions: Subscription[] }>('GET', '/discovery/subscriptions')).subscriptions.filter((s) => s.state === 'Enabled');
        setSubscriptions(subs);
        if (subs[0]) setForm((f) => ({ ...f, subscriptionId: f.subscriptionId || subs[0].id }));
      } catch (e) { await fail(e); }
    })();
  }, [open, subscriptions.length, api, fail]);

  useEffect(() => {
    if (!form.subscriptionId) return;
    setRegions(null);
    setActions(null);
    (async () => {
      try {
        const list = (await api<{ regions: Region[] }>('GET', `/discovery/regions?subscriptionId=${encodeURIComponent(form.subscriptionId)}`)).regions;
        setRegions(list);
        setForm((f) => ({ ...f, location: list.some((r) => r.name === f.location) ? f.location : (list[0]?.name ?? '') }));
      } catch (e) { await fail(e); }
    })();
  }, [form.subscriptionId, api, fail]);

  const update = (patch: Partial<typeof form>) => { setForm((f) => ({ ...f, ...patch })); setActions(null); };

  async function check() {
    setBusy('Checking…');
    setError(null);
    try {
      setActions((await api<{ actions: Action[] }>('POST', '/onboarding/check', form)).actions);
    } catch (e) { await fail(e); } finally { setBusy(null); }
  }

  async function apply() {
    setError(null);
    try {
      // Provider registration takes a minute or two; keep applying (it only does what's left) until everything is done.
      for (let attempt = 0; attempt < 40; attempt++) {
        setBusy(attempt === 0 ? 'Applying…' : 'Waiting for Azure to finish registering services…');
        const result = await api<{ actions: Action[]; ready: boolean }>('POST', '/onboarding/apply', form);
        setActions(result.actions);
        if (result.ready) { await loadOnboarded(); setOpen(false); return; }
        if (result.actions.some((a) => a.status === 'blocked') || !result.actions.some((a) => a.status === 'in-progress')) return;
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (e) { await fail(e); } finally { setBusy(null); }
  }

  const blocked = actions?.some((a) => a.status === 'blocked');
  return (
    <section className="card">
      <h2><span className="step">{step}</span>Onboard a subscription</h2>
      <p>Lets AKC AVD Deploy build Azure Virtual Desktop in <strong>one resource group</strong> of your subscription, and nowhere else. It's done once per resource group by an AVD Admin who is an Owner of the subscription.</p>

      {onboarded && onboarded.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Resource group</th><th>Region</th><th>Onboarded</th></tr></thead>
            <tbody>
              {onboarded.map((o) => (
                <tr key={`${o.subscriptionId}/${o.resourceGroup}`}>
                  <td>{o.resourceGroup} <span className="pill ok">Ready</span><div className="mono muted">{o.subscriptionId}</div></td>
                  <td>{o.location}{o.scaling && <div className="muted">Autoscale allowed</div>}</td>
                  <td>{when(o.onboardedAt)}<div className="muted">{o.onboardedBy}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="note err">{error}</div>}

      {!canOnboard ? (
        <p className="muted">An AVD Admin of your organisation onboards subscriptions.</p>
      ) : !open ? (
        <div className="actions"><button className="btn btn-primary" onClick={() => setOpen(true)}>{onboarded?.length ? 'Onboard another' : 'Onboard a subscription'}</button></div>
      ) : (
        <div className="onboard-form">
          <div className="form-grid">
            <div>
              <label htmlFor="ob-sub">Subscription</label>
              <select id="ob-sub" value={form.subscriptionId} onChange={(e) => update({ subscriptionId: e.target.value })}>
                {subscriptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ob-region">Region</label>
              <select id="ob-region" value={form.location} onChange={(e) => update({ location: e.target.value })} disabled={!regions}>
                {!regions && <option>Loading…</option>}
                {regions?.map((r) => <option key={r.name} value={r.name}>{r.displayName}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ob-rg">Resource group</label>
              <input id="ob-rg" type="text" maxLength={90} value={form.resourceGroup} onChange={(e) => update({ resourceGroup: e.target.value })} />
              <p className="hint">Created if it doesn't exist. Use a new, empty one.</p>
            </div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.scaling} onChange={(e) => update({ scaling: e.target.checked })} />
            <span>Allow autoscale<small>Hosts power down outside working hours to save money. Needs Azure Virtual Desktop's own power role on the subscription.</small></span>
          </label>

          {actions && (
            <ul className="action-list">
              {actions.map((a) => {
                const [mark, tone] = marks[a.status];
                return (
                  <li key={a.id}>
                    <span className={`action-mark ${tone}`}>{mark}</span>
                    <div><strong>{a.title}</strong><div className="muted">{a.detail}</div>{a.message && <div className={a.status === 'blocked' ? 'note err' : 'hint'}>{a.message}</div>}</div>
                  </li>
                );
              })}
            </ul>
          )}

          {busy && <div className="note">{busy}</div>}
          <div className="actions">
            {!actions ? (
              <button className="btn btn-primary" disabled={!!busy || !form.subscriptionId || !form.location} onClick={check}>Check what's needed</button>
            ) : (
              <button className="btn btn-primary" disabled={!!busy || blocked} onClick={apply}>Onboard</button>
            )}
            <button className="btn btn-secondary" disabled={!!busy} onClick={() => { setOpen(false); setActions(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
