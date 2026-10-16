const { randomUUID } = require('node:crypto');

// Bounded main-to-renderer requests, used only while Web is enabled. The sender that received a request
// must answer it; closing a browser never grants it a way to invoke arbitrary desktop IPC.
function createWebRequests({ window, timeout = 30_000 }) {
  const pending = new Map();
  return {
    invoke(method, args, viewId) {
      const sender = window()?.webContents;
      if (!sender || sender.isDestroyed()) return Promise.reject(new Error('桌面窗口尚未就绪。'));
      if (pending.size >= 128) return Promise.reject(new Error('等待桌面处理的请求过多。'));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('桌面操作结果尚未确认；请查看当前状态，操作未自动重发。'));
        }, timeout);
        pending.set(id, { sender, resolve, reject, timer });
        try {
          sender.send('remote:request', { id, method, args, viewId });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    reply(sender, response) {
      const entry = pending.get(response?.id);
      if (!entry || entry.sender !== sender) return;
      clearTimeout(entry.timer);
      pending.delete(response.id);
      if (response.ok === true) entry.resolve(response.result);
      else entry.reject(new Error(String(response.error || '桌面操作失败。')));
    },
    cancel() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Web 入口已关闭；已发送的操作未自动重发。'));
      }
      pending.clear();
    },
  };
}

module.exports = { createWebRequests };
