// The per-dock identity fields a DockStatus carries; client fixtures that only
// care about geometry spread this in so they still satisfy the wire contract.
export const DOCK_IDENTITY = {
  dockFirmwareVersion: '1.00.000',
  childFirmwareVersion: '1.00.000',
  serialNumber: 'A00000000000',
  childSerialNumber: 'A00000000001',
  productId: 0x80,
  macAddress: '00:00:00:00:00:00',
  mdnsServiceName: 'DeckBridge',
  deviceKey: '',
};
