import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Link,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from '@forge/react';
import { call } from './call';
import type { Finding } from '../core/challenge/challenge';
import { COPY_CHANGED_MESSAGE, UNTRUSTED_RECORD_MESSAGE } from '../core/record';
import { describeState } from '../core/rubric/states';
import type { CheckResult, Dispute, Evaluation, EvidenceItem, Recommendation } from '../core/types';

interface Verdict {
  recommendation: Recommendation;
  why: string;
  canSubmit: boolean;
  changed: boolean;
}

type PanelState =
  | { state: 'no-issue' }
  | { state: 'not-a-dispute'; issueKey: string }
  | { state: 'unverified'; issueKey: string }
  | {
      state: 'ready';
      issueKey: string;
      copyChanged: boolean;
      dispute: Dispute;
      evidence: EvidenceItem[];
      collectedAt: string | null;
      evaluation: Evaluation;
      findings: Finding[];
      verdict: Verdict;
    };

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

const SEVERITY = {
  decisive: { text: 'Decisive', appearance: 'removed' },
  weakens: { text: 'Weakens', appearance: 'moved' },
  note: { text: 'Note', appearance: 'default' },
} as const;

const EVIDENCE_LABEL: Record<string, string> = {
  delivery: 'Delivery',
  'delivery-signature': 'Signature at delivery',
  'customer-message': 'Customer message',
  refund: 'Refund',
  policy: 'Policy',
  'product-description': 'Product description',
  'order-pair': 'Charges on the order',
  incident: 'Incident',
  deploy: 'Deploy',
  '3ds': '3-D Secure',
  avs: 'Address check',
  cvv: 'Security code check',
  'prior-orders': 'Earlier orders',
  cancellation: 'Cancellation',
};

/** Exhibit letters: A to Z, then AA, AB and so on. */
const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + letter(i % 26));

const money = (d: Dispute) => `${(d.amount / 100).toLocaleString('en-US', { style: 'currency', currency: d.currency })}`;
const day = (iso: string) => iso.slice(0, 10);

function Exhibit({ item, index }: { item: EvidenceItem; index: number }) {
  const source = `${item.source.key}${item.meta?.version ? ` (${item.meta.version})` : ''}`;
  return (
    <Stack space="space.025">
      <Inline space="space.100" alignBlock="center">
        <Text weight="bold">Exhibit {letter(index)}</Text>
        <Text>
          {EVIDENCE_LABEL[item.type] ?? item.type}: {describeState(item.state)}
        </Text>
        <Lozenge appearance={item.kind === 'inference' ? 'new' : 'default'}>{item.kind === 'inference' ? 'Inference' : 'Fact'}</Lozenge>
      </Inline>
      {item.meta?.quote && <Text>"{item.meta.quote}"</Text>}
      <Inline space="space.100">
        {item.source.url ? <Link href={item.source.url} openNewTab>{source}</Link> : <Text color="color.text.subtle">{source}</Text>}
        <Text color="color.text.subtlest">{day(item.at)}</Text>
      </Inline>
    </Stack>
  );
}

function Requirement({ check, exhibitOf }: { check: CheckResult; exhibitOf: (e: EvidenceItem) => string | null }) {
  const s = STATUS[check.status];
  const cited = [check.evidence, ...check.contradictions].filter((e): e is EvidenceItem => !!e).map(exhibitOf).filter(Boolean);
  return (
    <Inline space="space.100" alignBlock="center">
      <Lozenge appearance={s.appearance}>{s.text}</Lozenge>
      <Tooltip content={check.rule}>
        <Text>
          {check.label}
          {check.required ? '' : ' (supporting)'}
        </Text>
      </Tooltip>
      {cited.length > 0 && <Text color="color.text.subtlest">Exhibit {[...new Set(cited)].join(', ')}</Text>}
    </Inline>
  );
}

function App() {
  const [data, setData] = useState<PanelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<PanelState>('getEvaluation')
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const collectAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await call<PanelState>('collectAgain'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <SectionMessage appearance="error" title="Exhibita couldn't load this dispute">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner label="Checking the evidence" />;
  if (data.state === 'unverified') {
    return (
      <SectionMessage appearance="error" title="Exhibita can't trust this record">
        <Text>{UNTRUSTED_RECORD_MESSAGE.unverified} Submission is blocked.</Text>
      </SectionMessage>
    );
  }
  if (data.state !== 'ready') {
    return <Text>This work item isn't an Exhibita dispute. Disputes arrive through the dispute webhook.</Text>;
  }

  const { dispute, evaluation, verdict, evidence, findings } = data;
  const shown = VERDICT[verdict.recommendation];
  const required = evaluation.checks.filter((c) => c.required);
  const supporting = evaluation.checks.filter((c) => !c.required);
  const exhibitOf = (e: EvidenceItem) => {
    const i = evidence.findIndex((x) => x.id === e.id);
    return i < 0 ? null : letter(i);
  };
  const against = findings.filter((f) => f.severity !== 'note');
  const notes = findings.filter((f) => f.severity === 'note');

  return (
    <Stack space="space.200">
      {data.copyChanged && (
        <SectionMessage appearance="warning" title="Record edited outside Exhibita">
          <Text>{COPY_CHANGED_MESSAGE}</Text>
        </SectionMessage>
      )}

      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance={shown.appearance} isBold>
            {shown.text}
          </Lozenge>
          <Text weight="bold">
            {money(dispute)} · {evaluation.reasonLabel ?? dispute.processorReason}
          </Text>
          {evaluation.reasonCode && <Text color="color.text.subtlest">{evaluation.reasonCode}</Text>}
        </Inline>
        <Text>{verdict.why}</Text>
      </Stack>

      {verdict.changed && (
        <SectionMessage appearance={verdict.recommendation === 'accept' ? 'error' : 'warning'} title={`Changed from ${VERDICT[evaluation.recommendation].text} to ${shown.text}`}>
          <Text>
            The checklist alone said {VERDICT[evaluation.recommendation].text.toLowerCase()}. The challenge found the case against us below.
          </Text>
        </SectionMessage>
      )}

      {evaluation.supported && (
        <Stack space="space.050">
          <Text>
            Evidence coverage: {evaluation.coverage.met} of {evaluation.coverage.total} required ({evaluation.coverage.label})
          </Text>
          <ProgressBar
            value={evaluation.coverage.total === 0 ? 0 : evaluation.coverage.met / evaluation.coverage.total}
            appearance={verdict.canSubmit ? 'success' : 'default'}
            ariaLabel="Evidence coverage"
          />
        </Stack>
      )}

      {!verdict.canSubmit && verdict.recommendation !== 'accept' && (
        <SectionMessage appearance="warning" title="Submit to network is blocked">
          <Text>
            {evaluation.blockers.length > 0 ? `Add: ${evaluation.blockers.join('; ')}` : `Resolve first: ${against.map((f) => f.title).join('; ') || verdict.why}`}
          </Text>
        </SectionMessage>
      )}

      <Box>
        <Heading size="xsmall">Required</Heading>
        <Stack space="space.075">
          {required.map((c) => (
            <Requirement key={c.id} check={c} exhibitOf={exhibitOf} />
          ))}
        </Stack>
      </Box>
      {supporting.length > 0 && (
        <Box>
          <Heading size="xsmall">Supporting</Heading>
          <Stack space="space.075">
            {supporting.map((c) => (
              <Requirement key={c.id} check={c} exhibitOf={exhibitOf} />
            ))}
          </Stack>
        </Box>
      )}

      {against.length > 0 && (
        <Box>
          <Heading size="xsmall">Case against us</Heading>
          <Stack space="space.100">
            {against.map((f, i) => (
              <Stack key={`${f.rule}-${i}`} space="space.025">
                <Inline space="space.100" alignBlock="center">
                  <Lozenge appearance={SEVERITY[f.severity].appearance}>{SEVERITY[f.severity].text}</Lozenge>
                  <Text weight="bold">{f.title}</Text>
                </Inline>
                <Text>{f.detail}</Text>
                {f.evidence.length > 0 && <Text color="color.text.subtlest">Exhibit {f.evidence.map(exhibitOf).filter(Boolean).join(', ')}</Text>}
              </Stack>
            ))}
          </Stack>
        </Box>
      )}

      <Box>
        <Heading size="xsmall">Exhibits</Heading>
        {evidence.length === 0 ? (
          <Text>No evidence collected yet. Exhibita never invents evidence; missing items stay missing.</Text>
        ) : (
          <Stack space="space.150">
            {evidence.map((e, i) => (
              <Exhibit key={e.id} item={e} index={i} />
            ))}
          </Stack>
        )}
      </Box>

      {notes.length > 0 && (
        <Stack space="space.050">
          {notes.map((f, i) => (
            <Text key={`${f.rule}-${i}`} color="color.text.subtle">
              Note: {f.detail}
            </Text>
          ))}
        </Stack>
      )}

      <Inline space="space.100" alignBlock="center">
        <Button onClick={collectAgain} isDisabled={busy}>
          {busy ? 'Collecting evidence…' : 'Collect evidence again'}
        </Button>
        {data.collectedAt && <Text color="color.text.subtlest">Last collected {data.collectedAt.slice(0, 16).replace('T', ' ')} UTC</Text>}
      </Inline>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
