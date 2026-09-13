// Bridgething daemon client: one shared instance for the whole app.
import { BridgethingClient } from '@bridgething/client';

import { daemonUrl } from './daemon';

let client: BridgethingClient | null = null;

export function getClient(): BridgethingClient {
  if (!client) client = new BridgethingClient({ url: daemonUrl() });
  return client;
}
