// Stands in for infra/mdns-advertiser.ts in the Node.js relay bundle (build.mjs alias):
// the real one needs dns-sd/avahi spawns or native FFI. relay-entry.ts forces --no-advertise.
// oxlint-disable-next-line typescript/no-extraneous-class -- must match the real export's shape
export class MdnsAdvertiser {
  constructor() {
    throw new Error('mDNS advertise is not supported in the Node.js relay');
  }
}
