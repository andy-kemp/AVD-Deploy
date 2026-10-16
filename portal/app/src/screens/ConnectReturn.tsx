// Microsoft sends the browser back here twice during Connect tenant: after admin consent (/connect/callback) and after
// the proof sign-in (/connect/verify). Each page passes Microsoft's answer to the API, which does every check.
import { useEffect, useRef, useState } from 'react';
import { message, useApi } from '../api';
import { Hero } from '../Chrome';

export function ConnectReturn({ step, onConnected }: { step: 'consented' | 'verify'; onConnected: () => Promise<void> }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    // States are single-use, so never send twice (React runs effects twice in development).
    if (sent.current) return;
    sent.current = true;
    const query = new URLSearchParams(window.location.search);
    const body =
      step === 'consented'
        ? { state: query.get('state'), tenant: query.get('tenant'), adminConsent: query.get('admin_consent'), error: query.get('error'), errorDescription: query.get('error_description') }
        : { state: query.get('state'), code: query.get('code'), error: query.get('error'), errorDescription: query.get('error_description') };
    // Keep the code and state out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    (async () => {
      try {
        if (step === 'consented') {
          const { url } = await api<{ url: string }>('POST', '/tenants/connect/consented', body);
          window.location.assign(url);
        } else {
          await api('POST', '/tenants/connect/verify', body);
          window.history.replaceState(null, '', '/');
          await onConnected();
        }
      } catch (e) {
        setError(message(e));
      }
    })();
  }, [api, step, onConnected]);

  return (
    <>
      <Hero eyebrow="Connect tenant" title={error ? "The tenant wasn't connected" : step === 'consented' ? 'Thanks — one more sign-in' : 'Checking your sign-in'}>
        {error ? null : step === 'consented' ? 'Consent was recorded. Next, sign in to the same tenant so we can confirm it is yours.' : 'Confirming the tenant and your administrator role…'}
      </Hero>
      {error && (
        <section className="card">
          <div className="note err">{error}</div>
          <div className="actions"><a className="btn btn-secondary" href="/">Back to AVD Deploy</a></div>
        </section>
      )}
    </>
  );
}
