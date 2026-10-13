import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';

// Main now completes the desktop-to-proxy handshake before opening a view. A refusal must keep the same upgrade
// information that the renderer used to receive as its first WebSocket frame.
export function bridgeAddress(
  client: Pick<ProxyClient, 'update'>,
  result: {
    url: string;
    failure?: Extract<ServerMessage, { type: 'connection.error' }>;
  },
) {
  const failure = result.failure;
  if (!failure) return result.url;
  if (failure.code === 'version_mismatch')
    client.update({
      mismatch: true,
      service: failure.service ?? null,
      release: failure.client?.version ?? null,
      preparing: failure.preparing
        ? failure.preparing.size
          ? failure.preparing.received / failure.preparing.size
          : 0
        : null,
    });
  // ProxyClient owns disconnect and retry state; a failed first handshake is never retried automatically.
  throw new Error(failure.message);
}
