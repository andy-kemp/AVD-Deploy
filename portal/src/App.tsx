import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from '@azure/msal-react';
import { loginRequest } from './authConfig';
import { Wizard } from './Wizard';

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
            <p>Sign in with your Entra account to plan an Azure Virtual Desktop deployment in the subscriptions you can access.</p>
            <button onClick={() => instance.loginRedirect(loginRequest)}>Sign in with Microsoft</button>
          </section>
        </UnauthenticatedTemplate>
        <AuthenticatedTemplate>
          <Wizard />
        </AuthenticatedTemplate>
      </main>
    </>
  );
}
