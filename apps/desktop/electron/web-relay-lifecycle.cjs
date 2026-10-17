const routePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
function validateRelayRoute(route) {
  if (typeof route !== 'string' || (route !== '' && routePattern.exec(route)?.[0] !== route))
    throw new Error('访问路径须为 1–64 位小写字母、数字或中划线，首尾为字母或数字。');
  return route;
}

// Relay access belongs to the Web listener, not the current business connection. Keep the chosen
// service in memory so switching or disconnecting that connection never redirects a browser.
function createWebRelayLifecycle({
  start,
  changed = () => {},
  route = '',
  defaultRoute = '',
  saveRoute = () => {},
}) {
  validateRelayRoute(route);
  validateRelayRoute(defaultRoute);
  if (route === defaultRoute) route = '';
  const effectiveRoute = () => route || defaultRoute;
  let controller;
  let configuration;
  let localPort;
  let generation = 0;
  let changingRoute = false;
  let current = {
    enabled: false,
    state: 'disabled',
    url: null,
    error: null,
    route: effectiveRoute(),
  };
  const publish = (value) => {
    current = { ...value, route: effectiveRoute() };
    if (!changingRoute) changed({ ...current });
  };
  const enabledStatus = (status) => ({ enabled: true, ...status, route: effectiveRoute() });
  const detach = async () => {
    const revision = ++generation;
    const previous = controller;
    controller = undefined;
    await previous?.close();
    return revision;
  };
  const resume = async (port) => {
    if (!configuration) return { ...current };
    localPort = port;
    const revision = await detach();
    if (revision !== generation || !configuration) return { ...current };
    publish(enabledStatus({ state: 'connecting', url: null, error: null }));
    try {
      const started = await start({
        config: { ...configuration },
        port,
        route,
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
    async setRoute(value) {
      validateRelayRoute(value);
      // Show the generated path in settings, but keep the empty default sentinel on the wire so
      // focusing or restoring that path never requires custom-route support from older servers.
      if (value === defaultRoute) value = '';
      if (changingRoute) throw new Error('正在应用访问路径，请稍后重试。');
      if (route === value) return { ...current };
      const previous = route;
      const transport = controller;
      changingRoute = true;
      try {
        await transport?.setRoute(value);
        try {
          await saveRoute(value);
        } catch (error) {
          if (transport && transport === controller) {
            try {
              await transport.setRoute(previous);
            } catch {
              // A lost acknowledgement can leave the server on the new path. Discard that
              // generation before restoring the last saved route; never expose a guessed URL.
              await resume(localPort);
            }
          }
          throw error;
        }
        route = value;
        if (configuration && !controller) await resume(localPort);
        publish(controller ? enabledStatus(controller.status) : current);
        return { ...current };
      } finally {
        changingRoute = false;
        publish(current);
      }
    },
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

module.exports = { createWebRelayLifecycle, validateRelayRoute };
