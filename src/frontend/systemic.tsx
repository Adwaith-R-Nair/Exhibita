import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Box, Button, Heading, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { call } from './call';

interface ClusterView {
  cluster: { incidentKey: string; deployKey: string | null; disputes: { issueKey: string }[] };
  blast: { disputesSoFar: number; customersNotYetDisputed: number; analystHoursSavedByBulkAccept: number };
  plan: { accept: { issueKey: string; refundIds: string[] }[]; voidRefunds: { refundId: string }[]; costBug: { summary: string } };
  incidentTitle: string | null;
  deployTitle: string | null;
  disputes: { issueKey: string; amount: number; currency: string; status: string; done: boolean }[];
  openToAccept: number;
  actions: {
    accepted?: { at: string; count: number };
    refundsQueued?: { at: string; count: number; trackingKey: string | null };
    costBug?: { at: string; key: string };
  };
  queuedRefunds: number;
  labels: { disputed: string; cost: string; owed: string };
}

interface View {
  clusters: ClusterView[];
  insights: { sentence: string }[];
  assumptions: { disputeFee: string; analystMinutesPerDispute: number };
}

type Pending = { incidentKey: string; action: 'accept' | 'refunds' | 'bug' } | null;

const browse = (key: string) => `/browse/${key}`;
const money = (amount: number, currency: string) => (amount / 100).toLocaleString('en-US', { style: 'currency', currency });

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Stack space="space.025">
      <Text weight="bold">{value}</Text>
      <Text color="color.text.subtle">{label}</Text>
    </Stack>
  );
}

function ClusterCard({ view, onChanged }: { view: ClusterView; onChanged: () => Promise<void> }) {
  const { cluster, blast, plan, actions } = view;
  const [confirm, setConfirm] = useState<Pending>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const incidentKey = cluster.incidentKey;
  const stuck = plan.voidRefunds.length;

  const run = async (action: 'accept' | 'refunds' | 'bug') => {
    setConfirm(null);
    setError(null);
    try {
      if (action === 'accept') {
        let remaining = view.openToAccept;
        while (remaining > 0) {
          setBusy(`Accepting disputes, ${remaining} to go…`);
          remaining = (await call<{ remaining: number }>('acceptStep', { incidentKey })).remaining;
        }
      } else if (action === 'refunds') {
        setBusy('Queueing proactive refunds…');
        await call('queueRefunds', { incidentKey });
      } else {
        setBusy('Filing the cost bug…');
        await call('fileCostBug', { incidentKey });
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const CONFIRM = {
    accept: `Accepts ${view.openToAccept} open disputes as you, posts the reason on each, and cancels ${stuck} stuck refunds for those payments, so no customer is paid twice when refunds are replayed. Accepting a dispute cannot be undone at the processor.`,
    refunds: `Adds ${blast.customersNotYetDisputed} customers (${view.labels.owed}) to the proactive refund queue for the payments team and opens one tracking work item. Exhibita does not move money.`,
    bug: `Creates a bug on ${cluster.deployKey ?? incidentKey}: "${plan.costBug.summary}", with the cost breakdown, linked to the incident.`,
  } as const;

  const shown = view.disputes.slice(0, 12);
  return (
    <Box xcss={{ borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width', borderRadius: 'radius.medium', padding: 'space.200' }}>
      <Stack space="space.200">
        <Stack space="space.050">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance="removed">Incident</Lozenge>
            <Link href={browse(incidentKey)}>{incidentKey}</Link>
            <Text weight="bold">{view.incidentTitle ?? ''}</Text>
          </Inline>
          {cluster.deployKey && (
            <Inline space="space.100" alignBlock="center">
              <Text color="color.text.subtle">Caused by</Text>
              <Link href={browse(cluster.deployKey)}>{cluster.deployKey}</Link>
              <Text color="color.text.subtle">{view.deployTitle ?? ''}</Text>
              <Text color="color.text.subtlest">(an explicit Jira link, not timing)</Text>
            </Inline>
          )}
        </Stack>

        <Inline space="space.400" shouldWrap>
          <Stat value={`${blast.disputesSoFar} disputes`} label={`${view.labels.disputed} disputed`} />
          <Stat value={view.labels.cost} label="cost so far, with dispute fees" />
          <Stat value={`${blast.customersNotYetDisputed} customers`} label={`not disputed yet, owed ${view.labels.owed}`} />
          <Stat value={`about ${blast.analystHoursSavedByBulkAccept} hours`} label="of analyst time" />
        </Inline>

        <Text>
          {shown.map((d, i) => (
            <React.Fragment key={d.issueKey}>
              {i > 0 ? ', ' : ''}
              <Link href={browse(d.issueKey)}>{d.issueKey}</Link>
              {` ${money(d.amount, d.currency)}${d.done ? ` (${d.status})` : ''}`}
            </React.Fragment>
          ))}
          {view.disputes.length > shown.length ? ` and ${view.disputes.length - shown.length} more` : ''}
        </Text>

        {confirm && (
          <SectionMessage appearance="warning" title="Please confirm">
            <Text>{CONFIRM[confirm.action]}</Text>
            <Inline space="space.100">
              <Button appearance="primary" onClick={() => run(confirm.action)}>
                Confirm
              </Button>
              <Button appearance="subtle" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </Inline>
          </SectionMessage>
        )}
        {busy && <Spinner label={busy} />}
        {busy && <Text>{busy}</Text>}
        {error && (
          <SectionMessage appearance="error" title="That did not finish">
            <Text>{error}</Text>
            <Text>Whatever was done is kept; running it again carries on from there.</Text>
          </SectionMessage>
        )}

        <Inline space="space.100" shouldWrap>
          {view.openToAccept > 0 ? (
            <Button appearance="primary" isDisabled={!!busy} onClick={() => setConfirm({ incidentKey, action: 'accept' })}>
              {`Accept ${view.openToAccept} disputes and cancel ${stuck} stuck refunds`}
            </Button>
          ) : (
            <Lozenge appearance="success">All disputes accepted</Lozenge>
          )}
          {actions.refundsQueued ? (
            <Inline space="space.050" alignBlock="center">
              <Lozenge appearance="success">{`${actions.refundsQueued.count} refunds queued`}</Lozenge>
              {actions.refundsQueued.trackingKey && <Link href={browse(actions.refundsQueued.trackingKey)}>{actions.refundsQueued.trackingKey}</Link>}
            </Inline>
          ) : (
            <Button isDisabled={!!busy || blast.customersNotYetDisputed === 0} onClick={() => setConfirm({ incidentKey, action: 'refunds' })}>
              {`Queue proactive refunds for ${blast.customersNotYetDisputed} customers`}
            </Button>
          )}
          {actions.costBug ? (
            <Inline space="space.050" alignBlock="center">
              <Lozenge appearance="success">Cost bug filed</Lozenge>
              <Link href={browse(actions.costBug.key)}>{actions.costBug.key}</Link>
            </Inline>
          ) : (
            <Button isDisabled={!!busy} onClick={() => setConfirm({ incidentKey, action: 'bug' })}>
              {`File the cost bug on ${cluster.deployKey ?? incidentKey}`}
            </Button>
          )}
        </Inline>
      </Stack>
    </Box>
  );
}

function App() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      setView(await call<View>('getView'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Exhibita couldn't load this page">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!view) return <Spinner label="Tracing disputes to their causes" />;

  return (
    <Stack space="space.400">
      <Stack space="space.100">
        <Heading size="large">Incidents behind your disputes</Heading>
        <Text>
          Disputes grouped under the incident an explicit link says caused them, with the customers the same incident affected who have not
          disputed yet. Nothing here is grouped by timing alone.
        </Text>
      </Stack>

      {view.clusters.length === 0 ? (
        <SectionMessage appearance="information" title="No incident clusters">
          <Text>No two disputes are linked to the same incident. Clusters appear here when they are.</Text>
        </SectionMessage>
      ) : (
        view.clusters.map((c) => <ClusterCard key={c.cluster.incidentKey} view={c} onChanged={load} />)
      )}

      {view.insights.length > 0 && (
        <Stack space="space.100">
          <Heading size="medium">Why we lose disputes</Heading>
          <Text color="color.text.subtle">From closed disputes in the payment records. Counts only, never a prediction.</Text>
          {view.insights.map((i) => (
            <Text key={i.sentence}>{i.sentence}</Text>
          ))}
        </Stack>
      )}

      <Text color="color.text.subtlest">
        {`Assumptions: a dispute fee of ${view.assumptions.disputeFee} per your processor agreement, and ${view.assumptions.analystMinutesPerDispute} minutes of analyst time per dispute worked by hand.`}
      </Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
