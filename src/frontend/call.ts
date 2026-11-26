import { invoke } from '@forge/bridge';

type Payload = Parameters<typeof invoke>[1];

/** Call a resolver and get its result typed. We never request invoke metadata, so the body is the result. */
export async function call<T>(functionKey: string, payload?: Payload): Promise<T> {
  return (await invoke<T>(functionKey, payload)) as T;
}
