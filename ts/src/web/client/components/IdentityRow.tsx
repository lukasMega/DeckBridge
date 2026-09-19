export function IdentityRow({
  label,
  children,
  class: className,
}: Readonly<{
  label: string;
  children: preact.ComponentChildren;
  class?: string;
}>): preact.JSX.Element {
  return (
    <li class={className}>
      <span class="identity-label">{label}</span>
      {children}
    </li>
  );
}
