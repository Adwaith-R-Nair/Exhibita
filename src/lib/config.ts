// App configuration in Forge KVS. The webhook secret is stored with setSecret so it is encrypted at rest.

import { kvs } from '@forge/kvs';
import { randomBytes } from 'node:crypto';

export interface AppConfig {
  projectKey: string;
  /** Orders at or above this many cents need a signed proof of delivery. */
  signatureThresholdMinor: number;
}

const CONFIG_KEY = 'config:v1';
const SECRET_KEY = 'webhook-secret:v1';

export const DEFAULT_CONFIG: AppConfig = { projectKey: 'DSP', signatureThresholdMinor: 15_000 };

export async function getConfig(): Promise<AppConfig> {
  const stored = await kvs.get<Partial<AppConfig>>(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

export async function saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next = { ...(await getConfig()), ...patch };
  if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(next.projectKey)) throw new Error('Project key must be 2 to 10 capital letters or digits');
  await kvs.set(CONFIG_KEY, next);
  return next;
}

export async function getWebhookSecret(): Promise<string | undefined> {
  return kvs.getSecret<string>(SECRET_KEY);
}

/** Create a new random secret, replacing any old one. Returned once so the admin can copy it. */
export async function rotateWebhookSecret(): Promise<string> {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  await kvs.setSecret(SECRET_KEY, secret);
  return secret;
}
