import { createHash } from 'node:crypto';
import type { AgentName } from '../shared/messages.ts';

// Must match sessionKey() in codeflower-sandbox: dsh-plugins/acp-ws/src/sessions.js.
export function sessionKey(harness: AgentName, nativeSessionId: string): string {
  const readable = /^[A-Za-z0-9._-]{1,96}$/.test(nativeSessionId);
  const suffix = readable
    ? nativeSessionId
    : createHash('sha256').update(nativeSessionId).digest('hex').slice(0, 32);
  return `${harness}-${suffix}`;
}
