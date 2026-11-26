import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Code,
  Heading,
  Inline,
  Lozenge,
  ProgressBar,
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

interface SeedProgress {
  status: 'idle' | 'running' | 'done' | 'failed';
  step: number;
  steps: string[];
  label: string;
  message: string;
  notes: string[];
  error: string | null;
}

interface DemoCheck {
  total: number;
  found: number;
  matching: number;
  mismatches: { issueKey: string | null; externalId: string; scenario: string; expected: string; actual: string }[];
}

interface ValidationReport {
  passed: number;
  total: number;
  results: { id: number; title: string; expected: string; observed: string; passed: boolean }[];
}

/** Drives "Set up demo data": one bounded step per call until done or failed. */
function DemoData() {
  const [progress, setProgress] = useState<SeedProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<SeedProgress>('seedStatus').then(setProgress).catch((e: unknown) => setError(String(e)));
  }, []);

  const go = async () => {
    setRunning(true);
    setError(null);
    try {
      let p = await call<SeedProgress>('seedStart');
      setProgress(p);
      while (p.status === 'running') {
        p = await call<SeedProgress>('seedStep');
        setProgress(p);
        // Another tab holds the lock, or Jira is still publishing: wait a moment instead of hammering.
        if (/another tab|still publishing/.test(p.message)) await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [checking, setChecking] = useState(false);
  const [demoCheck, setDemoCheck] = useState<DemoCheck | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);

  const remove = async () => {
    setConfirmRemove(false);
    setRunning(true);
    setError(null);
    try {
      let r = await call<{ status: string; message: string }>('removeStep');
      while (r.status === 'running') {
        setRemoveMessage(r.message);
        r = await call<{ status: string; message: string }>('removeStep');
      }
      setRemoveMessage(r.message);
      setProgress(await call<SeedProgress>('seedStatus'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const total = progress?.steps.length ?? 1;
  const done = progress?.status === 'done';
  return (
    <Stack space="space.100">
      <Heading size="medium">Demo data</Heading>
      <Text>
        Builds a synthetic demo world: the Disputes, Customer support, Incidents and Deploys projects, policy pages in Confluence, orders and
        payments, and about 60 disputes with their evidence. Takes a few minutes. Keep this page open while it runs.
      </Text>
      <Box>
        <Button appearance="primary" isDisabled={running || done} onClick={go}>
          {running ? 'Setting up…' : done ? 'Demo data is set up' : progress?.status === 'failed' ? 'Resume demo setup' : 'Set up demo data'}
        </Button>
      </Box>
      {progress && progress.status !== 'idle' && (
        <Stack space="space.050">
          <ProgressBar value={done ? 1 : progress.step / total} appearance={done ? 'success' : 'default'} ariaLabel="Demo setup progress" />
          <Text>
            {done ? 'Done.' : `Step ${progress.step + 1} of ${total}: ${progress.label}.`} {progress.message}
          </Text>
        </Stack>
      )}
      {progress?.notes.map((n) => (
        <SectionMessage key={n} appearance="warning">
          <Text>{n}</Text>
        </SectionMessage>
      ))}
      {done && !running && (
        <Stack space="space.075">
          <Box>
            <Button
              onClick={async () => {
                setChecking(true);
                try {
                  setDemoCheck(await call<DemoCheck | null>('checkDemo'));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setChecking(false);
                }
              }}
              isDisabled={checking}
            >
              {checking ? 'Checking every demo dispute…' : 'Check the demo disputes'}
            </Button>
          </Box>
          {demoCheck && (
            <SectionMessage appearance={demoCheck.mismatches.length === 0 ? 'success' : 'warning'}>
              <Text>
                {demoCheck.matching} of {demoCheck.total} demo disputes reach the recommendation the scenario intends.
              </Text>
              {demoCheck.mismatches.slice(0, 10).map((m) => (
                <Text key={m.externalId}>
                  {m.issueKey ?? m.externalId}: expected {m.expected}, got {m.actual} ({m.scenario})
                </Text>
              ))}
            </SectionMessage>
          )}
        </Stack>
      )}
      {(done || progress?.status === 'failed') && !running && (
        <Box>
          {confirmRemove ? (
            <SectionMessage appearance="warning" title="Remove all demo data?">
              <Text>
                Moves the projects setup created to the Jira trash (an admin can restore them for 60 days), removes the demo policy space,
                deletes the demo disputes and their stored records, and deletes the demo rows from the payment tables. Nothing setup did not
                create is touched.
              </Text>
              <Inline space="space.100">
                <Button appearance="danger" onClick={remove}>
                  Remove demo data
                </Button>
                <Button appearance="subtle" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
              </Inline>
            </SectionMessage>
          ) : (
            <Button appearance="subtle" onClick={() => setConfirmRemove(true)}>
              Remove demo data
            </Button>
          )}
        </Box>
      )}
      {removeMessage && (
        <SectionMessage appearance="success">
          <Text>{removeMessage}</Text>
        </SectionMessage>
      )}
      {(progress?.error || error) && (
        <SectionMessage appearance="error" title="Demo setup stopped">
          <Text>{progress?.error ?? error}</Text>
          <Text>Everything done so far is kept. Fix the cause, then resume.</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

function ValidationSuite() {
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Stack space="space.100">
      <Heading size="medium">Validation suite</Heading>
      <Text>Ten synthetic disputes, each checking one behaviour of the decision engine. The same cases run in the app's automated tests.</Text>
      <Box>
        <Button
          isDisabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setReport(await call<ValidationReport>('runValidation'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Running…' : 'Run validation suite'}
        </Button>
      </Box>
      {report && (
        <Stack space="space.075">
          <Text weight="bold">
            {report.passed} of {report.total} passed
          </Text>
          {report.results.map((r) => (
            <Inline key={r.id} space="space.100" alignBlock="center">
              <Lozenge appearance={r.passed ? 'success' : 'removed'}>{r.passed ? 'Pass' : 'Fail'}</Lozenge>
              <Text>
                {r.id}. {r.title}: {r.observed}
              </Text>
            </Inline>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function App() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [projectKey, setProjectKey] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realtimeSeen, setRealtimeSeen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
      {error && (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      <DemoData />

      <ValidationSuite />

      <Stack space="space.100">
        <Heading size="medium">Disputes project</Heading>
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
        <Box>
          <Button
            isDisabled={busy !== null}
            onClick={() =>
              run('project', async () => {
                const r = await call<{ project: { key: string; name: string }; created: boolean; rolesAdded: string[] }>('createProject');
                const roles = r.rolesAdded.length ? ` Added you to ${r.rolesAdded.join(' and ')}.` : ' You already have the admin and agent roles.';
                setNotice(`${r.created ? 'Created' : 'Found'} ${r.project.name} (${r.project.key}).${roles}`);
              })
            }
          >
            {busy === 'project' ? 'Setting up the project…' : 'Set up this project'}
          </Button>
        </Box>
        {notice && (
          <SectionMessage appearance="success">
            <Text>{notice}</Text>
          </SectionMessage>
        )}
      </Stack>

      <Stack space="space.100">
        <Heading size="medium">Dispute webhook</Heading>
        <Text>{'Send dispute events in a Stripe-compatible format to this address. Sign each one with the webhook secret the way Stripe does: an x-exhibita-signature (or stripe-signature) header of t=<unix time>,v1=<HMAC-SHA256 of "t.body">. Requests older than five minutes are refused.'}</Text>
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
        <Heading size="medium">Platform checks</Heading>
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
