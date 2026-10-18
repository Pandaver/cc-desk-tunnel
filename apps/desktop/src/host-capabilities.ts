// The browser is an independent controller, not an execution device. Keep its host boundary in one
// place; the conversation, protocol client and session actions remain the desktop's shared code.
export function hostCapabilities(host: 'desktop' | 'browser') {
  const local = host === 'desktop';
  return {
    localProjects: local,
    schedules: local,
    accountManagement: local,
    serviceManagement: local,
    nativeSettings: local,
  };
}
export type HostCapabilities = ReturnType<typeof hostCapabilities>;

// A pairing code belongs only to the initial exchange, never to navigation/history or browser storage.
export function takePairingCode(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
) {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('pair');
  if (code !== null) {
    params.delete('pair');
    const rest = params.toString();
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`,
    );
  }
  return code ?? '';
}
