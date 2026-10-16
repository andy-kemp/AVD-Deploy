import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { App } from './App';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const root = createRoot(document.getElementById('root')!);

if (!publishableKey || !/^pk_(test|live)_/.test(publishableKey)) {
  root.render(<p style={{ padding: 24 }}>Set VITE_CLERK_PUBLISHABLE_KEY in portal/app/.env.local (see .env.example).</p>);
} else {
  root.render(
    <StrictMode>
      {/* Clerk's default appearance, as on the audit tool, so every andykemp.com sign-in looks the same. */}
      <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
