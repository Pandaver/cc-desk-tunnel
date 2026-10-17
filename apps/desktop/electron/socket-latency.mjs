import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';

const limits = new WeakMap();

// The existing connection answers a nonce-bearing ping. Empty heartbeat pongs and other probes do
// not finish this one. A timeout only ends the measurement, never the connection or its heartbeat.
export function probeSocket(socket, { signal, timeoutMs = 3000 } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('延迟测试已取消。'));
  if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('服务连接未就绪。'));
  if (socket.bufferedAmount > 64 * 1024)
    return Promise.reject(new Error('服务连接正忙，请稍后测试。'));
  const now = performance.now();
  const limit = limits.get(socket) ?? { pending: 0, starts: [] };
  limits.set(socket, limit);
  limit.starts = limit.starts.filter((started) => now - started < 1000);
  if (limit.pending >= 4 || limit.starts.length >= 20)
    return Promise.reject(new Error('延迟测试过于频繁，请稍后重试。'));
  limit.pending++;
  limit.starts.push(now);
  return new Promise((resolve, reject) => {
    const nonce = Buffer.from(`latency:${randomBytes(16).toString('hex')}`);
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('pong', pong);
      socket.removeListener('close', closed);
      socket.removeListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      limit.pending--;
      if (error) reject(error);
      else resolve(Math.max(0, performance.now() - now));
    };
    const pong = (data) => {
      if (Buffer.isBuffer(data) && data.equals(nonce)) finish();
    };
    const closed = () => finish(new Error('服务连接已断开。'));
    const failed = () => finish(new Error('服务连接发生错误。'));
    const aborted = () => finish(new Error('延迟测试已取消。'));
    socket.on('pong', pong);
    socket.once('close', closed);
    socket.once('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('延迟测试超时。')), timeoutMs);
    try {
      socket.ping(nonce, (error) => {
        if (error) finish(new Error('延迟测试发送失败。'));
      });
    } catch {
      finish(new Error('延迟测试发送失败。'));
    }
  });
}
