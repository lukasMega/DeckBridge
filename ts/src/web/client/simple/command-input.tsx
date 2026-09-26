// Shell-command text field shared by the side-key "on press" cell and the knob grid.
// change (not input) — commits on blur/Enter, so a half-typed command never runs.

const COMMAND_MAX = 512; // mirrors ENCODER_COMMAND_MAX (types.ts)

export function CommandInput({
  value,
  label,
  placeholder,
  title,
  disabled = false,
  onCommit,
}: Readonly<{
  value: string;
  /** Accessible name — the grid's column header is not a real <label>. */
  label: string;
  placeholder: string;
  title: string;
  disabled?: boolean;
  onCommit: (command: string) => void;
}>): preact.JSX.Element {
  return (
    <input
      class="input xkey-select xkey-param"
      type="text"
      maxLength={COMMAND_MAX}
      value={value}
      placeholder={placeholder}
      title={title}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
    />
  );
}
