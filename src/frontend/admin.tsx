import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Code,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield,
} from '@forge/react';
import { realtime } from '@forge/bridge';
import { call } from './call';

interface Setup {
  config: { projectKey: string; signatureThresholdMinor: number };
  webhookUrl: string | null;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const SPIKE_CHANNEL = 'exhibita-platform-check';

function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [projectKey, setProjectKey] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realtimeSeen, setRealtimeSeen] = useState(false);

  useEffect(() => {
    call<Setup>('getSetup')
      .then((s) => {
        setSetup(s);
        setProjectKey(s.config.projectKey);
      })
      .catch((e: unknown) => setError(String(e)));
    const sub = realtime.subscribeGlobal(SPIKE_CHANNEL, () => setRealtimeSeen(true));
    return () => {
      void sub.then((s) => s.unsubscribe());
    };
  }, []);

  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  if (!setup && !error) return <Spinner label="Loading Exhibita setup" />;

  return (
    <Stack space="space.300">
      <Heading as="h1">Exhibita setup</Heading>
      {error && (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      <Stack space="space.100">
        <Heading as="h2">Disputes project</Heading>
        <Text>The Jira Service Management project where disputes are created.</Text>
        <Inline space="space.100" alignBlock="end">
          <Textfield name="projectKey" value={projectKey} onChange={(e) => setProjectKey(e.target.value.toUpperCase())} />
          <Button
            isDisabled={busy !== null}
            onClick={() => run('save', async () => setSetup({ ...setup!, ...(await call<{ config: Setup['config'] }>('saveSetup', { projectKey })) }))}
          >
            Save
          </Button>
        </Inline>
      </Stack>

      <Stack space="space.100">
        <Heading as="h2">Dispute webhook</Heading>
        <Text>Send dispute events in a Stripe-compatible format to this address, with the secret in an x-exhibita-secret header.</Text>
        {setup?.webhookUrl && <Code>{setup.webhookUrl}</Code>}
        <Box>
          <Button isDisabled={busy !== null} onClick={() => run('secret', async () => setSecret((await call<{ secret: string }>('rotateSecret')).secret))}>
            Create new webhook secret
          </Button>
        </Box>
        {secret && (
          <SectionMessage appearance="warning" title="Copy this secret now">
            <Text>It won't be shown again. Creating a new one replaces it.</Text>
            <Code>{secret}</Code>
          </SectionMessage>
        )}
      </Stack>

      <Stack space="space.100">
        <Heading as="h2">Platform checks</Heading>
        <Box>
          <Button
            appearance="primary"
            isDisabled={busy !== null}
            onClick={() => run('checks', async () => setChecks((await call<{ results: CheckResult[] }>('runChecks')).results))}
          >
            {busy === 'checks' ? 'Running checks…' : 'Run checks'}
          </Button>
        </Box>
        {checks?.map((c) => (
          <Inline key={c.name} space="space.100" alignBlock="center">
            <Lozenge appearance={c.ok ? 'success' : 'removed'}>{c.ok ? 'Pass' : 'Fail'}</Lozenge>
            <Text>
              {c.name}: {c.detail}
            </Text>
          </Inline>
        ))}
        {checks && (
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={realtimeSeen ? 'success' : 'moved'}>{realtimeSeen ? 'Pass' : 'Waiting'}</Lozenge>
            <Text>Realtime message received by this page</Text>
          </Inline>
        )}
      </Stack>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
