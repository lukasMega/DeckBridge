// What the WebUI hands an extension's ui.js: its own Preact, a few app components (so the
// page matches the app and survives class mangling) and fetch scoped to the extension's API.
import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExtensionUiApi, ExtensionUiKit } from '../../../extension/api.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { IdentityRow } from '../components/IdentityRow.js';
import { StatusChip } from '../components/StatusChip.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { useStore } from '../lib/store.js';

const kit: ExtensionUiKit = {
  Lead: ({ children }) => <p class="help-lead">{children}</p>,
  ErrorText: ({ children }) => <p class="settings-error">{children}</p>,
  SectionLabel: ({ children }) => <p class="help-section-label">{children}</p>,
  List: ({ children }) => <ul class="identity-list panel-inset">{children}</ul>,
  Row: ({ label, value }) => (
    <IdentityRow label={label}>
      <code class="identity-value">{value}</code>
    </IdentityRow>
  ),
  EmptyRow: ({ children }) => <li class="identity-label">{children}</li>,
  Field: ({ label, children }) => (
    <div class="tuning-field">
      <span>{label}</span>
      {children}
    </div>
  ),
  VisuallyHidden: ({ children }) => <div class="visually-hidden">{children}</div>,
  StatusChip,
  ChipRadioGroup,
};

const useDocks: ExtensionUiApi['useDocks'] = () => useStore((s) => s.status.docks);

export function createExtensionApi(id: string): ExtensionUiApi {
  const url = (path: string): string => `/api/ext/${id}/${encodeURIComponent(path)}`;
  return {
    apiVersion: 1,
    preact: { h, Fragment, render },
    hooks: { useState, useEffect, useRef, useMemo, useCallback },
    kit,
    getJson: (path, signal) => getJson(url(path), signal),
    postJson: (path, body) => postJson(url(path), body),
    useDocks,
  };
}
