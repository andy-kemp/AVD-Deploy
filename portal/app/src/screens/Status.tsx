import { useState } from 'react';
import type { AvdOrganisation } from '../api';
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

export function Welcome({ organisation }: { organisation: AvdOrganisation }) {
  const roles = organisation.roles.map((r) => roleNames[r] ?? r);
  return (
    <>
      <Hero eyebrow="Welcome" title={`${organisation.name} is ready`}>
        {roles.length ? `Your AVD role: ${roles.join(', ')}.` : "You don't have an AVD role in this organisation yet. Ask its AVD Admin to give you one."}
      </Hero>
      <section className="card">
        <h2><span className="step">1</span>Connect your Microsoft tenant</h2>
        <p>A Global Administrator or Cloud Application Administrator in your tenant approves the AKC AVD Deploy app once. It can then only do what each person's own Azure and Entra roles allow.</p>
        <div className="actions"><button className="btn btn-primary" disabled>Connect tenant</button><span className="muted">Coming next</span></div>
      </section>
      <section className="card">
        <h2><span className="step">2</span>Invite your team</h2>
        <p>Give colleagues Reader, Operator, Approver or Admin access.</p>
        <div className="actions"><button className="btn btn-secondary" disabled>Invite colleagues</button><span className="muted">Coming soon</span></div>
      </section>
    </>
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
