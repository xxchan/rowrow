// Mermaid diagrams in Markdown and in file previews (roamgate #26, #159, #346, #350): the pure
// parts, so tests reach them without a browser. Rendering is ./mermaid.ts, loaded on demand.

/** A diagram's source: without a byte-order mark, and unwrapped when a whole `.mmd` file is one ```mermaid fence. */
export function mermaidSource(text: string): string {
  const source = text.replace(/^\uFEFF/, "").trim();
  const fenced = /^(`{3,}|~{3,})mermaid[^\S\n]*\r?\n(?:([\s\S]*?)\r?\n)?\1$/i.exec(source);
  return fenced === null ? source : (fenced[2] ?? "").trim();
}

/** True when a source has nothing to draw: only front matter, `%%{…}%%` directives and `%%` comments. */
export function emptyDiagram(source: string): boolean {
  return (
    mermaidSource(source)
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
      .replace(/%%\{[\s\S]*?\}%%/g, "")
      .replace(/^\s*%%.*$/gm, "")
      .trim() === ""
  );
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The zoom at which `content` fits `viewport` (less 16 px of padding a side), never above
 * 100%. `toWidth` fits the width only: the viewport then grows to the diagram's height.
 */
export function fitScale(content: Size, viewport: Size, toWidth: boolean): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.max(
    0.001,
    Math.min(
      1,
      Math.max(1, viewport.width - 32) / content.width,
      toWidth ? 1 : Math.max(1, viewport.height - 32) / content.height,
    ),
  );
}

/**
 * CSS from a diagram (its `<style>` and `style` attributes, which a sanitizer doesn't read)
 * made unable to load anything: `url()` other than to the SVG's own definitions, `image-set()`,
 * `src()` and `@import` stop parsing, so the browser drops them. Escapes go first, since they
 * could spell those names.
 */
export function inertCss(css: string): string {
  return css
    .replaceAll("\\", "")
    .replace(/@import/gi, "@blocked")
    .replace(/(?:-[a-z]+-)?(?:image-set|image|cross-fade|element|src)\(|url\((?!\s*["']?#)/gi, "blocked(");
}

/**
 * `a` mixed into `b`, `weight` of the way, both `#rgb` or `#rrggbb` (a built stylesheet
 * shortens `#ffffff` to `#fff`); `b` when either is something else.
 */
export function mixHex(a: string, b: string, weight: number): string {
  const rgb = (hex: string): number[] | null => {
    const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)?.[1];
    if (digits === undefined) return null;
    const full = digits.length === 3 ? digits.replace(/./g, "$&$&") : digits;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  };
  const [from, to] = [rgb(a), rgb(b)];
  if (from === null || to === null) return b;
  return `#${from
    .map((c, i) => Math.round(c * weight + (to[i] ?? 0) * (1 - weight)))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}
