// Relay access belongs to the Web listener, not the current business connection. Keep the chosen
// service in memory so switching or disconnecting that connection never redirects a browser.
function createWebRelayLifecycle({ start, changed = () => {} }) {
  let controller;
  let configuration;
  let generation = 0;
  let current = { enabled: false, state: 'disabled', url: null, error: null };
  const publish = (value) => {
    current = value;
    changed({ ...current });
  };
  const enabledStatus = (status) => ({ enabled: true, ...status });
  const detach = async () => {
    const revision = ++generation;
    const previous = controller;
    controller = undefined;
    await previous?.close();
    return revision;
  };
  const resume = async (port) => {
    if (!configuration) return { ...current };
    const revision = await detach();
    if (revision !== generation || !configuration) return { ...current };
    publish(enabledStatus({ state: 'connecting', url: null, error: null }));
    try {
      const started = await start({
        config: { ...configuration },
        port,
        onStatus: (status) => {
          if (revision === generation && configuration) publish(enabledStatus(status));
        },
      });
      if (revision !== generation || !configuration) {
        await started.close();
        return { ...current };
      }
      controller = started;
      publish(enabledStatus(started.status));
    } catch (error) {
      if (revision === generation && configuration)
        publish(
          enabledStatus({
            state: 'error',
            url: null,
            error: error instanceof Error ? error.message : '中继连接失败，请重新启用。',
          }),
        );
    }
    return { ...current };
  };
  return {
    get status() {
      return { ...current };
    },
    context: (request) => controller?.context(request) ?? null,
    async enable(login, port) {
      if (configuration) return { ...current };
      if (login?.mode !== 'remote' || !login.url?.trim() || !login.token?.trim())
        throw new Error('请先填写远程代理的服务地址和凭据并连接，再启用服务端访问。');
      configuration = {
        url: login.url.trim(),
        token: login.token.trim(),
        fingerprint: String(login.fingerprint ?? '').trim(),
      };
      return resume(port);
    },
    async pause() {
      const revision = await detach();
      if (revision === generation && configuration)
        publish(enabledStatus({ state: 'connecting', url: null, error: null }));
    },
    resume,
    async disable() {
      configuration = undefined;
      publish({ enabled: false, state: 'disabled', url: null, error: null });
      await detach();
      return { ...current };
    },
  };
}

module.exports = { createWebRelayLifecycle };
