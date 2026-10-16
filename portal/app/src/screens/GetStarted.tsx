// Get started (docs/hosted-service.md, First run and invitations): choose or create an organisation you administer,
// then request AVD for it. Organisations are created and activated in the browser through Clerk; the request is stored
// by the API as pending until AKC approves it.
import { useMemo, useState } from 'react';
import { useOrganizationList, useUser } from '@clerk/react';
import { message, useApi, type Me } from '../api';
import { Hero } from '../Chrome';

// Free email providers don't name an organisation.
const personalDomains = /^(gmail|googlemail|outlook|hotmail|live|msn|icloud|me|yahoo|aol|proton|protonmail)\./i;

function suggestName(email: string | undefined): string {
  const domain = email?.split('@')[1] ?? '';
  if (!domain || personalDomains.test(domain)) return '';
  const label = domain.split('.')[0].replace(/[-_]+/g, ' ');
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function GetStarted({ me, onRequested }: { me: Me; onRequested: () => Promise<void> }) {
  const api = useApi();
  const { user } = useUser();
  const { isLoaded, userMemberships, createOrganization, setActive } = useOrganizationList({ userMemberships: { infinite: true } });
  const email = user?.primaryEmailAddress?.emailAddress;

  const memberships = userMemberships?.data ?? [];
  const adminOrgs = memberships.filter((m) => m.role === 'org:admin');
  const memberOrgs = memberships.filter((m) => m.role !== 'org:admin');
  const activeIsAdmin = me.organisation?.canRequest ? me.organisation.id : '';

  const [choice, setChoice] = useState<'new' | 'existing' | null>(null);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mode = choice ?? (adminOrgs.length ? 'existing' : 'new');
  const selectedId = selected || activeIsAdmin || adminOrgs[0]?.organization.id || '';
  const newName = name ?? suggestName(email);
  const selectedName = useMemo(() => adminOrgs.find((m) => m.organization.id === selectedId)?.organization.name ?? '', [adminOrgs, selectedId]);

  async function request() {
    setError(null);
    const orgName = (mode === 'new' ? newName : selectedName).trim();
    if (!orgName) { setError(mode === 'new' ? 'Enter a name for your organisation.' : 'Choose an organisation.'); return; }
    try {
      let orgId = selectedId;
      if (mode === 'new') {
        setBusy('Creating your organisation…');
        orgId = (await createOrganization!({ name: orgName })).id;
      }
      setBusy('Requesting access…');
      await setActive!({ organization: orgId });
      await api('POST', '/organisations/request', { name: orgName, requesterName: user?.fullName ?? '', requesterEmail: email ?? '' }, { freshToken: true });
      await onRequested();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Hero eyebrow="Get started" title="Set up AVD Deploy for your organisation">
        AVD Deploy builds Azure Virtual Desktop in your own Azure subscription. Start by choosing the organisation you'll use it for.
      </Hero>

      <section className="card">
        <h2><span className="step">1</span>Your organisation</h2>
        {!isLoaded ? <p className="muted">Loading your organisations…</p> : (
          <div className="choices">
            <label className={`choice${mode === 'new' ? ' selected' : ''}`}>
              <input type="radio" name="org-mode" checked={mode === 'new'} onChange={() => setChoice('new')} />
              <span>Create a new organisation<small>You'll be its admin and can invite colleagues later.</small></span>
            </label>
            {mode === 'new' && (
              <div className="choice-detail">
                <label htmlFor="org-name">Organisation name</label>
                <input id="org-name" type="text" maxLength={100} value={newName} onChange={(e) => setName(e.target.value)} placeholder="Your company" />
                {suggestName(email) && <p className="hint">Suggested from your email address. Change it if you like.</p>}
              </div>
            )}
            {adminOrgs.length > 0 && (
              <label className={`choice${mode === 'existing' ? ' selected' : ''}`}>
                <input type="radio" name="org-mode" checked={mode === 'existing'} onChange={() => setChoice('existing')} />
                <span>Use one you already manage<small>Organisations where you are admin, for example from another AKC tool.</small></span>
              </label>
            )}
            {mode === 'existing' && adminOrgs.length > 0 && (
              <div className="choice-detail">
                <label htmlFor="org-existing">Organisation</label>
                <select id="org-existing" value={selectedId} onChange={(e) => setSelected(e.target.value)}>
                  {adminOrgs.map((m) => <option key={m.organization.id} value={m.organization.id}>{m.organization.name}</option>)}
                </select>
              </div>
            )}
            {memberOrgs.length > 0 && (
              <p className="hint">You're also a member of {memberOrgs.map((m) => m.organization.name).join(', ')}. To use AVD Deploy there, ask that organisation's admin to invite you.</p>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2><span className="step">2</span>What happens next</h2>
        <ol className="next-steps">
          <li>We review new organisations during the private beta, usually within one working day.</li>
          <li>Once approved, you connect your Microsoft tenant. A Global Administrator approves the AKC AVD Deploy app once.</li>
          <li>You link your work account, then design, preview and deploy into your own subscription.</li>
        </ol>
        {error && <div className="note err">{error}</div>}
        {busy && <div className="note">{busy}</div>}
        <div className="actions">
          <button className="btn btn-primary" disabled={!isLoaded || !!busy} onClick={request}>Request access</button>
        </div>
      </section>
    </>
  );
}
