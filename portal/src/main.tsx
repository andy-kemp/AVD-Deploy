import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createStandardPublicClientApplication, EventType, type AccountInfo } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { App } from './App';
import { configError, msalConfig } from './authConfig';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

if (configError) {
  root.render(<main><section><div className="note err">{configError}</div></section></main>);
} else {
  const msal = await createStandardPublicClientApplication(msalConfig);
  const accounts = msal.getAllAccounts();
  if (!msal.getActiveAccount() && accounts.length > 0) msal.setActiveAccount(accounts[0]);
  msal.addEventCallback((event) => {
    // MSAL v5: the LOGIN_SUCCESS payload is the AccountInfo.
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      msal.setActiveAccount(event.payload as AccountInfo);
    }
  });

  root.render(
    <StrictMode>
      <MsalProvider instance={msal}>
        <App />
      </MsalProvider>
    </StrictMode>,
  );
}
