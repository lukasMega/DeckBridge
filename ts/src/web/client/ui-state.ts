export type DeviceState = 'no-device' | 'no-device-elgato-conflict' | 'device-no-elgato' | 'ready';

export interface HelpStep {
  you: boolean;
  html: string;
}

export interface HelpTopic {
  title: string;
  lead: string;
  svg: () => string;
  steps: HelpStep[];
  docs?: { href: string; label: string };
}

export const CORA_PORT = '5343';
export const CORA_ADDR = `127.0.0.1:${CORA_PORT}`;
