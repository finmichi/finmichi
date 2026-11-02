// SPDX-License-Identifier: AGPL-3.0-only
import { Brand } from './design/brand';
import { LoadingState, ErrorState } from './design/feedback';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, Button, Stack, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { createLedgerTheme, cssVariablesResolver } from './design/theme';
import { readPreference, writePreference } from './design/location';
import { WorkspaceProvider } from './design/workspace';
import { LedgerAppShell } from './design/app-shell';
import { WorkspacePages } from './design/pages';
import '@mantine/core/styles.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/noto-sans-tc/400.css';
import '@fontsource/noto-sans-tc/500.css';
import '@fontsource/noto-sans-tc/700.css';
import './design/shell.css';
type Preference = 'system' | 'light' | 'dark';
function App() {
  const [preference, setPreference] = useState<Preference>(() => {
    const p = readPreference('finmichi-theme');
    return p === 'light' || p === 'dark' ? p : 'system';
  });
  const dark = useMediaQuery('(prefers-color-scheme: dark)', false, {
    getInitialValueInEffect: false,
  });
  const mode = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
  const [status, setStatus] = useState('loading'),
    [subject, setSubject] = useState('');
  useEffect(() => {
    void fetch('/api/me')
      .then(async (r) => {
        if (r.ok) {
          const me = await r.json();
          setSubject(me.user.subject);
          setStatus('signed-in');
        } else {
          // Finish the response stream even when only the HTTP status is used.
          await r.arrayBuffer();
          setStatus(r.status === 401 ? 'signed-out' : 'error');
        }
      })
      .catch(() => setStatus('error'));
  }, []);
  async function logout() {
    try {
      const r = await fetch('/auth/logout', { method: 'POST' });
      if (!r.ok) throw new Error();
      setStatus('signed-out');
    } catch {
      setStatus('error');
    }
  }
  function theme(value: Preference) {
    setPreference(value);
    writePreference('finmichi-theme', value);
  }
  return (
    <MantineProvider
      theme={createLedgerTheme(mode)}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme={mode}
    >
      {status === 'signed-in' ? (
        <WorkspaceProvider>
          <LedgerAppShell
            preference={preference}
            onTheme={theme}
            subject={subject}
            onLogout={() => void logout()}
          >
            <WorkspacePages subject={subject} onLogout={() => void logout()} />
          </LedgerAppShell>
        </WorkspaceProvider>
      ) : (
        <main className="auth-page">
          <Stack>
            <Title className="auth-brand">
              <Brand />
            </Title>
            {status === 'loading' ? (
              <LoadingState label="載入登入狀態" />
            ) : status === 'error' ? (
              <ErrorState
                message="無法連線，請重試。"
                retry={() => window.location.reload()}
              />
            ) : (
              <Button component="a" href="/auth/login">
                登入
              </Button>
            )}
          </Stack>
        </main>
      )}
    </MantineProvider>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js');
