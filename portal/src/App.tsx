import { useEffect, useState } from 'react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from '@azure/msal-react';
import { armScope, loginRequest } from './authConfig';
import { listSubscriptions, type Subscription } from './arm';

export function App() {
  const { instance, accounts } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0];

  return (
    <>
      <header>
        <h1>AVD Deploy</h1>
        <AuthenticatedTemplate>
          <span className="who">
            {account?.username}
            <button className="link" onClick={() => instance.logoutRedirect({ account })}>Sign out</button>
          </span>
        </AuthenticatedTemplate>
      </header>
      <main>
        <UnauthenticatedTemplate>
          <section>
            <h2>Sign in</h2>
            <p>Sign in with your Entra account to see the Azure subscriptions you can deploy to.</p>
            <button onClick={() => instance.loginRedirect(loginRequest)}>Sign in with Microsoft</button>
          </section>
        </UnauthenticatedTemplate>
        <AuthenticatedTemplate>
          <Subscriptions />
        </AuthenticatedTemplate>
      </main>
    </>
  );
}

function Subscriptions() {
  const { instance, accounts } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0];
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    (async () => {
      try {
        const { accessToken } = await instance.acquireTokenSilent({ scopes: [armScope], account });
        const result = await listSubscriptions(accessToken);
        if (!cancelled) setSubscriptions(result);
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) {
          await instance.acquireTokenRedirect({ scopes: [armScope], account });
          return;
        }
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [instance, account]);

  return (
    <section>
      <h2>Your Azure subscriptions</h2>
      {error && <div className="note err">{error}</div>}
      {!error && subscriptions === null && <p className="hint">Loading…</p>}
      {subscriptions?.length === 0 && (
        <div className="note warn">You don't have access to any subscriptions in this tenant.</div>
      )}
      {subscriptions && subscriptions.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Subscription ID</th><th>State</th></tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.subscriptionId}>
                  <td>{s.displayName}</td>
                  <td className="mono">{s.subscriptionId}</td>
                  <td><span className={s.state === 'Enabled' ? 'pill ok' : 'pill'}>{s.state}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
