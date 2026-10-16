import { useEffect, useState } from 'react';
import { ApiError, message, useApi, type AvdOrganisation, type Region, type Subscription } from '../api';
import { Hero } from '../Chrome';

const roleNames: Record<string, string> = { reader: 'Reader', operator: 'Operator', approver: 'Approver', admin: 'Admin' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function Waiting({ organisation, onCheck }: { organisation: AvdOrganisation; onCheck: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  return (
    <>
      <Hero eyebrow="Request sent" title={`Thanks — we're reviewing ${organisation.name}`} />
      <section className="card">
        <p>AVD Deploy is in private beta, so we review each new organisation. You'll have access here as soon as it's approved, usually within one working day.</p>
        <p className="muted">Requested {when(organisation.requestedAt)}.</p>
        <div className="actions">
          <button className="btn btn-secondary" disabled={checking} onClick={async () => { setChecking(true); await onCheck(); setChecking(false); }}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <span className="muted">Questions? <a href="mailto:hello@andykemp.com">hello@andykemp.com</a></span>
        </div>
      </section>
    </>
  );
}

export function Welcome({ organisation, onChanged }: { organisation: AvdOrganisation; onChanged: () => Promise<void> }) {
  const api = useApi();
  const roles = organisation.roles.map((r) => roleNames[r] ?? r);
  const isAdmin = organisation.permissions.includes('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      // The API returns Microsoft's admin consent page for this attempt; Microsoft sends the browser back to /connect/callback.
      window.location.assign((await api<{ url: string }>('POST', '/tenants/connect/start')).url);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  const tenant = organisation.tenant;
  return (
    <>
      <Hero eyebrow="Welcome" title={`${organisation.name} is ready`}>
        {roles.length ? `Your AVD role: ${roles.join(', ')}.` : "You don't have an AVD role in this organisation yet. Ask its AVD Admin to give you one."}
      </Hero>
      <section className="card">
        <h2><span className="step">1</span>{tenant ? 'Microsoft tenant connected' : 'Connect your Microsoft tenant'}</h2>
        {tenant ? (
          <>
            <p><strong>{tenant.name || 'Your tenant'}</strong> <span className="pill ok">Connected</span></p>
            <p className="muted">Tenant ID <span className="mono">{tenant.tenantId}</span>. Approved by {tenant.consentedBy} on {when(tenant.connectedAt)}.</p>
          </>
        ) : (
          <>
            <p>A Global Administrator or Cloud Application Administrator in your tenant approves the AKC AVD Deploy app once, then signs in once more so we can confirm the tenant is yours. The app can only ever do what each person's own Azure and Entra roles allow.</p>
            {error && <div className="note err">{error}</div>}
            <div className="actions">
              {isAdmin && organisation.connectAvailable ? (
                <button className="btn btn-primary" disabled={busy} onClick={connect}>{busy ? 'Opening Microsoft…' : 'Connect tenant'}</button>
              ) : (
                <>
                  <button className="btn btn-primary" disabled>Connect tenant</button>
                  <span className="muted">{!organisation.connectAvailable ? 'Coming soon' : 'Ask an AVD Admin in your organisation to connect the tenant.'}</span>
                </>
              )}
            </div>
          </>
        )}
      </section>
      {tenant && <LinkAccount organisation={organisation} onChanged={onChanged} />}
      {tenant && organisation.link && <Subscriptions onRelink={onChanged} />}
      <section className="card">
        <h2><span className="step">{tenant && organisation.link ? 4 : tenant ? 3 : 2}</span>Invite your team</h2>
        <p>Give colleagues Reader, Operator, Approver or Admin access.</p>
        <div className="actions"><button className="btn btn-secondary" disabled>Invite colleagues</button><span className="muted">Coming soon</span></div>
      </section>
    </>
  );
}

function LinkAccount({ organisation, onChanged }: { organisation: AvdOrganisation; onChanged: () => Promise<void> }) {
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = organisation.link;

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2><span className="step">2</span>{link ? 'Your Microsoft account is linked' : 'Link your Microsoft work account'}</h2>
      {link ? (
        <>
          <p><strong>{link.username}</strong> <span className="pill ok">Linked</span>{link.mfa && <> <span className="pill ok">MFA</span></>}</p>
          <p className="muted">Linked {when(link.linkedAt)}. AVD Deploy works in Azure as you, with your own permissions, and never as anyone else.</p>
        </>
      ) : (
        <p>Sign in once with your own account in {organisation.tenant?.name || 'your tenant'}. AVD Deploy then shows and does only what your Azure and Entra roles allow. Your sign-in is stored encrypted, and you can unlink at any time.</p>
      )}
      {error && <div className="note err">{error}</div>}
      <div className="actions">
        {link ? (
          <button className="btn btn-secondary" disabled={!!busy} onClick={() => run('Unlinking…', async () => { await api('DELETE', '/accounts/link'); await onChanged(); setBusy(null); })}>
            {busy ?? 'Unlink'}
          </button>
        ) : organisation.linkAvailable ? (
          <button className="btn btn-primary" disabled={!!busy} onClick={() => run('Opening Microsoft…', async () => { window.location.assign((await api<{ url: string }>('POST', '/accounts/link/start')).url); })}>
            {busy ?? 'Link Microsoft account'}
          </button>
        ) : (
          <><button className="btn btn-primary" disabled>Link Microsoft account</button><span className="muted">Coming soon</span></>
        )}
      </div>
    </section>
  );
}

// First discovery: the subscriptions the operator can see in the connected tenant, and where AVD is offered.
function Subscriptions({ onRelink }: { onRelink: () => Promise<void> }) {
  const api = useApi();
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [regions, setRegions] = useState<Record<string, Region[] | 'loading' | string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api<{ subscriptions: Subscription[] }>('GET', '/discovery/subscriptions');
        if (!cancelled) setSubscriptions(result.subscriptions);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === 'relink-needed') { await onRelink(); return; }
        setError(message(e));
      }
    })();
    return () => { cancelled = true; };
  }, [api, onRelink]);

  async function loadRegions(id: string) {
    setRegions((r) => ({ ...r, [id]: 'loading' }));
    try {
      const result = await api<{ regions: Region[] }>('GET', `/discovery/regions?subscriptionId=${encodeURIComponent(id)}`);
      setRegions((r) => ({ ...r, [id]: result.regions }));
    } catch (e) {
      setRegions((r) => ({ ...r, [id]: message(e) }));
    }
  }

  return (
    <section className="card">
      <h2><span className="step">3</span>Your Azure subscriptions</h2>
      <p className="muted">What your own account can see in the connected tenant.</p>
      {error && <div className="note err">{error}</div>}
      {!subscriptions && !error && <p className="muted">Loading…</p>}
      {subscriptions?.length === 0 && <div className="note">Your account can't see any subscriptions in this tenant. Ask a subscription Owner to give you access.</div>}
      {subscriptions && subscriptions.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Subscription</th><th>State</th><th>AVD regions</th></tr></thead>
            <tbody>
              {subscriptions.map((s) => {
                const r = regions[s.id];
                return (
                  <tr key={s.id}>
                    <td>{s.name}<div className="mono muted">{s.id}</div></td>
                    <td><span className={`pill ${s.state === 'Enabled' ? 'ok' : ''}`}>{s.state}</span></td>
                    <td>
                      {r === undefined ? <button className="btn btn-secondary btn-small" onClick={() => loadRegions(s.id)}>Show</button>
                        : r === 'loading' ? <span className="muted">Loading…</span>
                        : typeof r === 'string' ? <span className="muted">{r}</span>
                        : r.length ? r.map((x) => x.displayName).join(', ') : <span className="muted">None available</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Declined({ organisation }: { organisation: AvdOrganisation }) {
  return (
    <>
      <p className="eyebrow">AVD Deploy</p>
      <h1>{organisation.status === 'suspended' ? `${organisation.name} is suspended` : `${organisation.name} wasn't approved`}</h1>
      <section className="card">
        <p>{organisation.status === 'suspended' ? 'Access to AVD Deploy is paused for this organisation.' : "We couldn't approve this organisation for the private beta."} Please contact <a href="mailto:hello@andykemp.com">hello@andykemp.com</a> and we'll help.</p>
      </section>
    </>
  );
}
