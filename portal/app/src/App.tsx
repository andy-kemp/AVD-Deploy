import { useCallback, useEffect, useState } from 'react';
import { OrganizationSwitcher, SignIn, UserButton, useAuth } from '@clerk/react';
import { message, useApi, type Me } from './api';
import { SiteFooter, SiteHeader } from './Chrome';
import { AdminRequests } from './screens/AdminRequests';
import { GetStarted } from './screens/GetStarted';
import { Declined, Waiting, Welcome } from './screens/Status';

export function App() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return <Page><div className="centre-page"><p className="muted">Loading…</p></div></Page>;
  }
  if (!isSignedIn) {
    // Signed out: the whole page is the sign-in, with sign-up in the same box, as on the audit tool.
    return (
      <Page>
        <div className="sign-in-page"><SignIn routing="hash" withSignUp fallbackRedirectUrl="/" /></div>
      </Page>
    );
  }
  return <SignedInApp />;
}

function Page({ children, nav }: { children: React.ReactNode; nav?: React.ReactNode }) {
  return (
    <>
      <SiteHeader>{nav}</SiteHeader>
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}

function SignedInApp() {
  const api = useApi();
  const { orgId } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = window.location.pathname.replace(/\/+$/, '') || '/';

  // The active organisation decides the screen; reload whenever it changes.
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setMe(await api<Me>('GET', '/me', undefined, { freshToken: true }));
    } catch (e) {
      setError(message(e));
    }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh, orgId]);

  const nav = (
    <>
      {me?.isAkcAdmin && <a href={path === '/admin' ? '/' : '/admin'}>{path === '/admin' ? 'My organisation' : 'Organisation requests'}</a>}
      <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" afterCreateOrganizationUrl="/" />
      <UserButton />
    </>
  );

  let content: React.ReactNode;
  if (error) {
    content = <section className="card"><div className="note err">{error}</div><button className="btn btn-secondary" onClick={refresh}>Try again</button></section>;
  } else if (!me) {
    content = <p className="muted">Loading…</p>;
  } else if (path === '/admin') {
    content = me.isAkcAdmin ? <AdminRequests /> : <section className="card"><p>This page is for AKC staff.</p></section>;
  } else {
    const avd = me.organisation?.avd;
    if (!avd) content = <GetStarted me={me} onRequested={refresh} />;
    else if (avd.status === 'pending') content = <Waiting organisation={avd} onCheck={refresh} />;
    else if (avd.status === 'approved') content = <Welcome organisation={avd} />;
    else content = <Declined organisation={avd} />;
  }

  return (
    <Page nav={nav}>
      <div className="content-page"><div className="wrap narrow">{content}</div></div>
    </Page>
  );
}
