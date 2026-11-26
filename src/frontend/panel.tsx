import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Heading,
  Inline,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from '@forge/react';
import { call } from './call';
import type { CheckResult, Dispute, Evaluation, EvidenceItem } from '../core/types';

type PanelState =
  | { state: 'no-issue' }
  | { state: 'not-a-dispute'; issueKey: string }
  | { state: 'ready'; issueKey: string; dispute: Dispute; evidence: EvidenceItem[]; evaluation: Evaluation };

const VERDICT = {
  fight: { text: 'Fight', appearance: 'success' },
  accept: { text: 'Accept', appearance: 'removed' },
  investigate: { text: 'Investigate', appearance: 'moved' },
} as const;

const STATUS = {
  met: { text: 'Met', appearance: 'success' },
  conceded: { text: 'Customer is right', appearance: 'removed' },
  contradicted: { text: 'Conflicting', appearance: 'moved' },
  failed: { text: 'Against us', appearance: 'removed' },
  missing: { text: 'Missing', appearance: 'default' },
} as const;

const money = (d: Dispute) => `${(d.amount / 100).toLocaleString('en-US', { style: 'currency', currency: d.currency })}`;

function Requirement({ check }: { check: CheckResult }) {
  const s = STATUS[check.status];
  return (
    <Inline space="space.100" alignBlock="center">
      <Lozenge appearance={s.appearance}>{s.text}</Lozenge>
      <Tooltip content={check.rule}>
        <Text>
          {check.label}
          {check.required ? '' : ' (supporting)'}
        </Text>
      </Tooltip>
    </Inline>
  );
}

function App() {
  const [data, setData] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<PanelState>('getEvaluation')
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Exhibita couldn't load this dispute">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner label="Checking the evidence" />;
  if (data.state !== 'ready') {
    return <Text>This work item isn't an Exhibita dispute. Disputes arrive through the dispute webhook.</Text>;
  }

  const { dispute, evaluation } = data;
  const verdict = VERDICT[evaluation.recommendation];
  const required = evaluation.checks.filter((c) => c.required);
  const supporting = evaluation.checks.filter((c) => !c.required);

  return (
    <Stack space="space.200">
      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance={verdict.appearance} isBold>
            {verdict.text}
          </Lozenge>
          <Text weight="bold">
            {money(dispute)} · {evaluation.reasonLabel ?? dispute.processorReason}
          </Text>
          {evaluation.reasonCode && <Text color="color.text.subtlest">{evaluation.reasonCode}</Text>}
        </Inline>
        <Text>{evaluation.why}</Text>
      </Stack>

      {evaluation.supported && (
        <Stack space="space.050">
          <Text>
            Evidence coverage: {evaluation.coverage.met} of {evaluation.coverage.total} required ({evaluation.coverage.label})
          </Text>
          <ProgressBar
            value={evaluation.coverage.total === 0 ? 0 : evaluation.coverage.met / evaluation.coverage.total}
            appearance={evaluation.canSubmit ? 'success' : 'default'}
            ariaLabel="Evidence coverage"
          />
        </Stack>
      )}

      {!evaluation.canSubmit && evaluation.recommendation !== 'accept' && (
        <SectionMessage appearance="warning" title="Submit to network is blocked">
          <Text>Add: {evaluation.blockers.join('; ') || 'a supported reason code'}</Text>
        </SectionMessage>
      )}

      <Box>
        <Heading as="h4">Required</Heading>
        <Stack space="space.075">
          {required.map((c) => (
            <Requirement key={c.id} check={c} />
          ))}
        </Stack>
      </Box>
      {supporting.length > 0 && (
        <Box>
          <Heading as="h4">Supporting</Heading>
          <Stack space="space.075">
            {supporting.map((c) => (
              <Requirement key={c.id} check={c} />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
