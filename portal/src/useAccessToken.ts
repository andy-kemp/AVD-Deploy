import { useCallback } from 'react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';

// Thrown when a scope needs sign-in or consent; the caller shows a button, because browsers block popups not started by a click.
export class InteractionNeededError extends Error {
  constructor(readonly scope: string) {
    super('Additional sign-in or consent is needed.');
  }
}

export function useAccessToken() {
  const { instance } = useMsal();
  return useCallback(
    async (scope: string, interactive = false): Promise<string> => {
      const account = instance.getActiveAccount() ?? undefined;
      try {
        return (await instance.acquireTokenSilent({ scopes: [scope], account })).accessToken;
      } catch (e) {
        if (!(e instanceof InteractionRequiredAuthError)) throw e;
        if (!interactive) throw new InteractionNeededError(scope);
        // A popup keeps the half-filled form; a redirect would lose it.
        return (await instance.acquireTokenPopup({ scopes: [scope], account })).accessToken;
      }
    },
    [instance],
  );
}
