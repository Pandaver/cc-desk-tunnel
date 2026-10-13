// Single packaging boundary for the desktop's shared control runtime. Its package bundles this entry,
// including ws and the protocol, so main.cjs never relies on the source checkout's node_modules.
export { createControlHub } from './control-hub.mjs';
export { openControlEndpoint } from './control-endpoint.mjs';
export { startWebServer } from './web-server.mjs';
export { WebSocket } from 'ws';
export { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
