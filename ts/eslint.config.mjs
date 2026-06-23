// @xts-nocheck — sonarjs ships legacy ESLint v8 types; runtime shape is correct
import { defineConfig } from 'eslint/config';
import sonarjs from 'eslint-plugin-sonarjs';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';
import regexpPlugin, { configs as regexpConfigs } from 'eslint-plugin-regexp';
import boundaries from 'eslint-plugin-boundaries';
import eslintReact from '@eslint-react/eslint-plugin';
import { resolve } from 'node:path';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  // TypeScript parser for all source files
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
  },

  // SonarJS recommended ruleset (passed as-is to avoid type conflicts on spread)
  sonarjs.configs.recommended,
  regexpConfigs.recommended,

  // Typed linting (type-aware rules; parserOptions.project is set above). Landed at
  // 'warn' (non-blocking) as a ratchet: the existing findings — including real
  // floating/misused-promise bugs (driver-manager.ts, app.ts) — are a tracked
  // follow-up cleanup. Promote individual rules to 'error' as they're cleared.
  ...tseslint.configs.strictTypeCheckedOnly.map((c) => ({
    ...c,
    // Type-aware rules only run where type info exists (parserOptions.project covers
    // src/test .ts). Without this scope they crash on plain .js (e.g. web/client/ui.js).
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    // Downgrade error→warn (ratchet) but KEEP the preset's disabled rules off — it
    // turns core rules like `no-undef` off because TS already checks them; re-enabling
    // them floods on the `tjs` runtime global. Preserve each rule's options too.
    ...(c.rules
      ? {
          rules: Object.fromEntries(
            Object.entries(c.rules).map(([k, v]) => {
              const sev = Array.isArray(v) ? v[0] : v;
              if (sev === 'off' || sev === 0) return [k, v];
              return [k, Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn'];
            }),
          ),
        }
      : {}),
  })),
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      // Conflicts with the established fire-and-forget arrow pattern (`() => sideEffect()`).
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Binary-protocol/logging code interpolates numbers & buffers freely.
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      // Disable sonar rules that don't apply to this codebase
      // void-use: fire-and-forget is the established txiki.js pattern
      'sonarjs/void-use': 'off',
      'sonarjs/todo-tag': 'warn',

      // Useful rules:
      // cognitive-complexity: cyclomatic complexity already enforced by oxlint at 10
      'sonarjs/cognitive-complexity': ['error', 14],
    },
  },

  // Relax noisy sonar rules for test files
  {
    files: ['test/**/*.ts', 'test/**/*.tsx'],
    rules: {
      'sonarjs/slow-regex': 'off',
      'sonarjs/no-empty-test-file': 'off',
    },
  },

  // Preact-aware linting for the browser UI ONLY (src/web/client/**).
  // @eslint-react is renderer-agnostic: `importSource: 'preact'` resolves JSX/hook
  // semantics against Preact, and pinning `version` BELOW 19 suppresses React-19-only
  // rules (no-forward-ref / no-context-provider / no-use-context) that would misfire
  // on patterns Preact 10 still uses. react-x ships its own rules-of-hooks +
  // exhaustive-deps, so no separate eslint-plugin-react-hooks is needed.
  // The only custom hook (useStore) follows `use*` naming and is auto-detected; add
  // settings['react-x'].additionalStateHooks/additionalEffectHooks regex only if a
  // non-`use*`-named custom hook is introduced.
  // Ratchet: every preset rule is downgraded to 'warn' (matching the typed-lint
  // convention above); the genuine-bug correctness rules are re-promoted to 'error'
  // in the override block below. `recommended-typescript` is a single flat-config
  // object, so transform it directly (not via .map).
  (() => {
    const c = eslintReact.configs['recommended-typescript'];
    return {
      ...c,
      files: ['src/web/client/**/*.ts', 'src/web/client/**/*.tsx'],
      settings: { ...c.settings, 'react-x': { importSource: 'preact', version: '18.3.1' } },
      rules: Object.fromEntries(
        Object.entries(c.rules).map(([k, v]) => {
          const sev = Array.isArray(v) ? v[0] : v;
          if (sev === 'off' || sev === 0) return [k, v];
          return [k, Array.isArray(v) ? ['warn', ...v.slice(1)] : 'warn'];
        }),
      ),
    };
  })(),
  {
    files: ['src/web/client/**/*.ts', 'src/web/client/**/*.tsx'],
    rules: {
      // Genuine bugs, not style — keep these blocking.
      '@eslint-react/rules-of-hooks': 'error',
      '@eslint-react/no-missing-key': 'error',
      '@eslint-react/jsx-no-key-after-spread': 'error',
      '@eslint-react/set-state-in-render': 'error',
    },
  },

  // Architecture boundaries (runtime-tier enforcement).
  // See "Architecture is lint-enforced" in /deckbridge/CLAUDE.md for the element map
  // and guardrails (G1-G4), and how to add a legitimate new edge.
  /* prettier-ignore */
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': resolve(import.meta.dirname),
      'boundaries/include': ['src/**/*.ts', 'src/**/*.tsx'],
      'boundaries/ignore': ['src/**/*.d.ts', 'test/**', 'dist/**', 'coverage/**'],
      'import/resolver': { typescript: { project: './tsconfig.json' } },
      'boundaries/flag-as-external': {
        inNodeModules: true,
        unresolvableAlias: true,
        customSourcePatterns: ['tjs', 'tjs:*', 'virtual:*'],
      },
      'boundaries/elements': [
        { type: 'web-client', mode: 'full', pattern: 'src/web/client/**' },
        { type: 'web-server', mode: 'full', pattern: 'src/web/server/**' },
        { type: 'ffi', mode: 'full', pattern: 'src/ffi/**' },
        { type: 'platform', mode: 'full', pattern: 'src/platform/**' },
        { type: 'assets', mode: 'full', pattern: 'src/assets/**' },
        { type: 'devices', mode: 'full', pattern: ['src/devices/**', 'src/mirabox.ts'] },
        { type: 'worker', mode: 'full', pattern: 'src/hid-worker.ts' },
        { type: 'worker-host', mode: 'full', pattern: 'src/hid-worker-host.ts' },
        { type: 'worker-ipc', mode: 'full', pattern: 'src/hid-worker-protocol.ts' },
        { type: 'transform', mode: 'full', pattern: ['src/translator.ts', 'src/image-render.ts', 'src/splash-sender.ts'] },
        { type: 'image-main', mode: 'full', pattern: ['src/image-pipeline.ts', 'src/image-cache.ts', 'src/image-assembler.ts'] },
        { type: 'cora', mode: 'full', pattern: ['src/cora-*.ts', 'src/elgato*.ts', 'src/feature-response.ts'] },
        { type: 'infra', mode: 'full', pattern: ['src/native-libs.ts', 'src/mdns-advertiser.ts', 'src/tray.ts'] },
        { type: 'app', mode: 'full', pattern: ['src/app.ts', 'src/driver-manager.ts', 'src/cora-startup.ts'] },
        { type: 'dev-entry', mode: 'full', pattern: ['src/mirabox-smoke.ts', 'src/k1pro-probe.ts'] },
        { type: 'shared', mode: 'full', pattern: ['src/types.ts', 'src/logger.ts', 'src/capabilities.ts', 'src/comm-format.ts']
        },
      ],
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // same-element internal imports always allowed
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            // Multi-file element types: same-type imports are always allowed (e.g. one
            // web-client module importing another, one cora server importing another).
            // No `capture` is configured, so `relationship: internal` (same element
            // *instance*) doesn't cover cross-file same-type imports — these do.
            { from: { type: 'web-client' }, allow: { to: { type: 'web-client' } } },
            { from: { type: 'web-server' }, allow: { to: { type: 'web-server' } } },
            { from: { type: 'devices' }, allow: { to: { type: 'devices' } } },
            { from: { type: 'cora' }, allow: { to: { type: 'cora' } } },
            { from: { type: 'transform' }, allow: { to: { type: 'transform' } } },
            { from: { type: 'infra' }, allow: { to: { type: 'infra' } } },
            { from: { type: 'app' }, allow: { to: { type: 'app' } } },
            { from: { type: 'ffi' }, allow: { to: { type: 'ffi' } } },

            // ── universal leaves (excluding web-client: G1 keeps the browser tier importing
            //    only web-client — see the dedicated web-client rule below) ──
            { from: { type: '!web-client' }, allow: { to: { type: ['shared', 'worker-ipc'] } } },
            // `devices/driver.ts` defines the cross-tier DeviceDriver/DeviceModel contract types;
            // any non-browser tier may depend on it for *types only*, never for runtime device code.
            {
              from: { type: '!web-client' },
              allow: { to: { type: 'devices' }, dependency: { kind: 'type' } },
            },
            {
              from: { type: ['platform', 'ffi', 'shared', 'worker-ipc'] },
              allow: { to: { type: 'platform' } },
            },

            // ── tier A (main thread) ──
            {
              from: { type: 'app' },
              allow: {
                to: {
                  type: [
                    'cora',
                    'web-server',
                    'infra',
                    'image-main',
                    'worker-host',
                    'devices',
                    'transform',
                    'ffi',
                  ],
                },
              },
            },
            {
              from: { type: 'cora' },
              allow: { to: { type: ['image-main', 'infra', 'platform'] } },
            },
            // capabilities.ts (shared) needs the DeviceConfig type from elgato-types.ts (cora) —
            // type-only, defines the shared CORA child-device capability shape.
            {
              from: { type: 'shared' },
              allow: { to: { type: 'cora' }, dependency: { kind: 'type' } },
            },
            // web-server may read FFI capability candidates (path enumeration only — no device I/O),
            // and the device registry (for DEFAULT_MODEL) — never live device I/O.
            {
              from: { type: 'web-server' },
              allow: { to: { type: ['ffi', 'devices'] } },
              message:
                'web-server may import ffi ONLY for capability/requirements checks (getHidapiSystemCandidates) and devices ONLY for the static registry (e.g. DEFAULT_MODEL), never for device I/O.',
            },
            // image-main (image-pipeline.ts) takes type-only references to the cora and web-server
            // composition surfaces it's wired into (ElgatoChildServer, WebUIServer) — orchestration
            // typing only, no runtime dependency.
            {
              from: { type: 'image-main' },
              allow: { to: { type: ['cora', 'web-server'] }, dependency: { kind: 'type' } },
            },

            // ── bridge ──
            { from: { type: 'worker-host' }, allow: { to: { type: 'worker-ipc' } } },

            // ── tier B (USB worker) ──
            { from: { type: 'worker' }, allow: { to: { type: ['devices', 'transform'] } } },
            { from: { type: 'devices' }, allow: { to: { type: ['ffi', 'transform'] } } },
            { from: { type: 'transform' }, allow: { to: { type: ['ffi', 'image-main', 'assets'] } } },

            // ── dev entries can reach worker-tier code directly ──
            {
              from: { type: 'dev-entry' },
              allow: { to: { type: ['devices', 'transform', 'ffi', 'image-main'] } },
            },

            // ── tier C (browser): web-client is isolated; only same-element (internal) above. ──
          ],
        },
      ],
    },
  },

  // Unused imports / vars / declarations
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    plugins: {
      'unused-imports': unusedImports,
      '@typescript-eslint': tseslint.plugin,
      regexp: regexpPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
      'regexp/no-unused-capturing-group': 'warn',
    },
  },
]);
