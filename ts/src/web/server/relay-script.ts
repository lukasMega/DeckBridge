// Where the relay install script is served (OrbStack and other-device routes, issue #257).
// The script itself is deviceScript() in relay-script-device.ts.

/** Own listener, not the WebUI: that one is loopback-only, so a VM can't reach it. */
export const RELAY_SCRIPT_PORT = 44661;
export const RELAY_SCRIPT_PATH = '/relay.sh';
