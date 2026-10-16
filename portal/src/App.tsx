import { useEffect, useState } from 'react';
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from '@azure/msal-react';
import { loginRequest } from './authConfig';
import { RunList, RunPage } from './Runs';
import { Wizard } from './Wizard';
import { workerConfigured } from './worker';

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => { setHash(window.location.hash); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const { instance, accounts } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0];
  const hash = useHashRoute();
  const runId = /^#\/runs\/([0-9a-f-]{36})$/.exec(hash)?.[1];

  return (
    <>
      <header>
        <h1>AVD Deploy</h1>
        <AuthenticatedTemplate>
          <nav>
            <a href="#/">New deployment</a>
            {workerConfigured && <a href="#/runs">Runs</a>}
          </nav>
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
            <p>Sign in with your Entra account to plan and deploy Azure Virtual Desktop in the subscriptions you can access.</p>
            <button onClick={() => instance.loginRedirect(loginRequest)}>Sign in with Microsoft</button>
          </section>
        </UnauthenticatedTemplate>
        <AuthenticatedTemplate>
          {runId && workerConfigured ? <RunPage key={runId} jobId={runId} /> : hash === '#/runs' && workerConfigured ? <RunList /> : <Wizard />}
        </AuthenticatedTemplate>
      </main>
    </>
  );
}
