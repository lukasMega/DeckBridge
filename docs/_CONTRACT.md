# Shared build contract — protocol-explainer.html (Phases 1 & 2)

Single-file, offline, zero-dependency interactive HTML page. Two agents build in parallel:
- **Phase 1** → `protocol-explainer.html` (the shell: structure, CSS, nav, toggle, legend, static tables, byte-map MOUNT points, and a script placeholder).
- **Phase 2** → `_byte-map.js` (the interactive byteMap component + BYTE_SPECS data + auto-init) and `_byte-map-demo.html` (self-verification only).

The parent will later inline `_byte-map.js` into the shell at the placeholder. Follow this contract EXACTLY so they compose.

## Theme (Phase 1 defines on :root; Phase 2 must not define CSS)
```
--bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --fg:#e6edf3; --muted:#8b949e;
--accent:#58a6ff; --border:#30363d;
/* field-group palette */
--c-header:#d6336c; --c-flags:#f59f00; --c-op:#9775fa; --c-id:#4dabf7;
--c-len:#22b8cf; --c-key:#51cf66; --c-ascii:#94d82d; --c-payload:#6b7280;
```
Monospace stack: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`.

Field groups (exact names): `header, flags, op, id, len, key, ascii, payload`.

## byte-map CSS class contract (Phase 1 defines, Phase 2 only uses)
- `.byte-map` — mount container (Phase 1 emits `<div class="byte-map" data-spec="NAME"></div>`)
- `.byte-map__title`, `.byte-map__source`
- `.byte-map__grid` — flex-wrap row of cells
- `.byte-map__cell` — one byte; carries `data-group` and `data-off`; `.is-active` when highlighted.
  Color comes from `.byte-map__cell[data-group="header"]{ ... var(--c-header) }` etc.
- `.byte-map__table`, `.byte-map__row` (carries `data-group`, `.is-active`), cells via `<td>`
- `.byte-map__callout` — detail box shown on hover/focus
Cells/rows are keyboard-focusable (`tabindex="0"`); `.is-active` is the shared highlight state.

## Mount points (Phase 1 places these `data-spec` divs in the right sections)
| Section | data-spec |
|---------|-----------|
| 1c (gen2 image) | `gen2-image` |
| 1c (gen1 image) | `gen1-image` |
| 2b (CORA frame) | `cora-frame` |
| 2f (capabilities) | `capabilities` |
| 2h (key event) | `key-event` |
| 2i (keepalive) | `keepalive` |

## Script placeholder (Phase 1 puts this exact line right before `</body>`)
```
<!-- BYTE_MAP_SCRIPT -->
```

## Altitude toggle
Body classes `level-map` (default) / `level-frames` / `level-wire`. Elements marked
`data-level="frames"` show in frames+wire; `data-level="wire"` show only in wire. Phase 1 implements.

## Spec format (Phase 2)
```
NAME: { title, source, bytes:[u8...], fields:[ {off,len,name,value,group,note} ] }
```
`bytes` may be only a header window; fields beyond the window still appear in the table and still
show a callout on hover, they just have no cell to highlight (must not error).
