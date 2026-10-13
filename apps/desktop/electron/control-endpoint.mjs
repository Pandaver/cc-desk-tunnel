import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '@cc-desk-tunnel/protocol';

// Private desktop adapter. Browser access goes through web-server's authenticated endpoint instead.
export async function openControlEndpoint(hub) {
  const route = `/control/${randomBytes(32).toString('hex')}`;
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== route || ![undefined, 'null', 'file://'].includes(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => hub.attach(ws));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}${route}`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
