// MSAL v5 redirect bridge: hands the authorisation response back to the page that started sign-in.
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

broadcastResponseToMainFrame().catch((error: unknown) => {
  console.error('Sign-in response could not be returned to the app.', error);
});
