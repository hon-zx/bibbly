/**
 * Where sign-in returns (bibbly://oauth on a phone, /oauth in the browser
 * preview). The auth session that opened the browser reads the result; this
 * screen only finishes the hand-off and goes back.
 */
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { useTheme } from '../src/theme';
import { Mascot } from '../src/ui/Mascot';
import { Body, Screen } from '../src/ui/kit';

export default function OAuthReturn() {
  const t = useTheme();
  useEffect(() => {
    // In the browser this posts the result to the window that opened the sign-in; on phones it does nothing.
    const r = WebBrowser.maybeCompleteAuthSession();
    if (r.type !== 'success') {
      const h = setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/settings')), 300);
      return () => clearTimeout(h);
    }
  }, []);
  return (
    <Screen>
      <Mascot state="think" size={96} />
      <Body style={{ color: t.ink2, textAlign: 'center' }}>Finishing sign-in…</Body>
    </Screen>
  );
}
