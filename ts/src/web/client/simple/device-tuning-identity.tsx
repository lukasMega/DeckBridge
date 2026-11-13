import { TuningGroup } from '../components/Fields.js';
import type { DeviceOverridesView } from '../ui-types.js';

export type CoraIdentityDraft = {
  dockSerialNumber: string;
  childSerialNumber: string;
  macAddress: string;
  dockFirmwareVersion: string;
  childFirmwareVersion: string;
};

export function buildCoraOverride(
  view: DeviceOverridesView,
  identity: CoraIdentityDraft,
  profileId: string,
): Record<string, unknown> | undefined {
  const cora: Record<string, unknown> = { ...view.overrides.cora };
  for (const [key, value] of Object.entries(identity)) {
    if (value.trim()) cora[key] = value.trim();
    else delete cora[key];
  }
  if (view.profiles.length) {
    const profile = view.profiles.find((p) => p.id === profileId);
    if (profile) Object.assign(cora, { advertiseAs: profile.id, productId: profile.productId });
    else {
      delete cora.advertiseAs;
      delete cora.productId;
    }
  }
  return Object.keys(cora).length ? cora : undefined;
}

export function ElgatoIdentityFields({
  value,
  onChange,
}: Readonly<{
  value: CoraIdentityDraft;
  onChange: (value: CoraIdentityDraft) => void;
}>): preact.JSX.Element {
  return (
    <TuningGroup title="Elgato identity">
      <p class="help-lead">
        Blank serial/MAC fields use generated or physical identity. Blank firmware fields use the
        model default or forwarded hardware firmware.
      </p>
      {(
        [
          ['dockSerialNumber', 'Dock serial number'],
          ['childSerialNumber', 'Panel serial number'],
          ['macAddress', 'MAC address'],
          ['dockFirmwareVersion', 'Dock firmware version'],
          ['childFirmwareVersion', 'Panel firmware version'],
        ] as const
      ).map(([key, label]) => (
        <label class="tuning-field" key={key}>
          <span>{label}</span>
          <input
            class="input"
            type="text"
            value={value[key]}
            onInput={(event) => onChange({ ...value, [key]: event.currentTarget.value })}
          />
        </label>
      ))}
    </TuningGroup>
  );
}
