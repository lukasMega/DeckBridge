export function cssClasses(css: string): Map<string, number>;

export function assertMangled(out: {
  map: Map<string, string>;
  kept: Map<string, string>;
  classes: number;
  js: string;
  css: string[];
}): void;

export function selectedClasses(sources: string[], known: Set<string>): Set<string>;

export function mangleClasses(
  cssParts: string[],
  js: string,
  selected?: Iterable<string>,
): {
  js: string;
  css: string[];
  stats: {
    classes: number;
    mangled: number;
    kept: number;
    stray: number;
    selected: number;
    prefix: number;
  };
  kept: Map<string, string>;
};
