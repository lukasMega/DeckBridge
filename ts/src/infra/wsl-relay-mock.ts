/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
// Scripted WslRunner for reviewing the WSL relay UI without WSL (DECKBRIDGE_WSL_RELAY_MOCK).
// Plays the same states a real run would, with short delays so each one is visible.
import { formatTime, LEVEL_TAG } from '../shared/logger.js';
import type { LogLevel } from '../shared/logger.js';
import type { WslRunner, WslSpawned } from './wsl-relay.js';

export type MockWslScenario = 'happy' | 'no-wsl' | 'mirrored' | 'old-glibc' | 'blocked';

const MOCK_IP = '172.28.16.5';
const HASH = 'a'.repeat(64);

export function isMockWslScenario(s: string): s is MockWslScenario {
  return ['happy', 'no-wsl', 'mirrored', 'old-glibc', 'blocked'].includes(s);
}

function detectOutput(s: MockWslScenario): string {
  const glibc = s === 'old-glibc' ? '2.35' : '2.39';
  return [
    'kernel=5.15.153.1-microsoft-standard-WSL2',
    'arch=x86_64',
    `glibc=glibc ${glibc}`,
    `ip=${MOCK_IP}`,
    `mode=${s === 'mirrored' ? 'mirrored' : 'nat'}`,
    'distro=Ubuntu-24.04',
  ].join('\n');
}

function logLine(level: LogLevel, message: string): string {
  return `${formatTime()} ${LEVEL_TAG[level]} [relay] ${message}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createMockWslRunner(scenario: MockWslScenario, delayMs = 600): WslRunner {
  let downloaded = false;
  let zipFile = '';
  return {
    async exec(args) {
      await sleep(delayMs);
      if (args[0] === 'pkill') return { code: 1, stdout: '' };
      if (scenario === 'no-wsl') {
        return {
          code: 1,
          stdout: 'Windows Subsystem for Linux has no installed distributions.',
        };
      }
      return { code: 0, stdout: detectOutput(scenario) };
    },

    spawn(args, onLine): WslSpawned {
      const target = args[args.indexOf('--target') + 1] ?? '';
      const timers: ReturnType<typeof setTimeout>[] = [];
      const done = Promise.withResolvers<number | null>();
      const at = (ms: number, line: string): void => {
        timers.push(setTimeout(() => onLine(line), ms));
      };
      at(delayMs / 4, logLine('info', `relay → ${target}:5343`));
      if (scenario === 'blocked') {
        at(
          delayMs / 2,
          logLine('warn', `waiting for DeckBridge at ${target}:5343: connect ETIMEDOUT`),
        );
      } else {
        at(delayMs, logLine('info', 'dock: sn=MOCK0001 pid=0x00a5 child port 5344'));
        at(delayMs * 2, logLine('info', 'listening on 0.0.0.0:5343 and :5344'));
      }
      return {
        exited: done.promise,
        stop(): Promise<void> {
          for (const t of timers) clearTimeout(t);
          done.resolve(null);
          return Promise.resolve();
        },
      };
    },

    async download(url): Promise<void> {
      await sleep(delayMs);
      zipFile = url.split('/').pop() ?? '';
      downloaded = true;
    },
    fetchText: () => Promise.resolve(`${HASH}  ${zipFile}\n`),
    sha256: () => Promise.resolve(HASH),
    unzip: () => sleep(delayMs / 2),
    toWslPath: () => Promise.resolve('/mnt/c/mock/wsl-relay/deckbridge'),
    exists: () => Promise.resolve(downloaded),
    promote: () => Promise.resolve(),
    pruneOthers: () => Promise.resolve(),
  };
}
