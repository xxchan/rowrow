// Draws Mermaid diagrams. Mermaid is most of a megabyte, so this module loads with the first
// diagram on screen (MermaidDiagram imports it), never with the app.
import DOMPurify from "dompurify";
import mermaid, { type MermaidConfig } from "mermaid";
import { inertCss, mixHex, type Size } from "./diagram.ts";

export interface Drawn extends Size {
  /** Sanitized SVG markup, ready for the page. */
  readonly svg: string;
}

const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Attributes that load what they name. Only references to the diagram's own parts stay. */
const LINKS = new Set(["href", "xlink:href"]);
const LOADS = new Set(["src", "srcset", "poster", "background", "action", "formaction", "ping", "data"]);
/** Attributes that hold CSS, which a sanitizer doesn't read. */
const CSS = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);

// Our own instance: Mermaid configures the shared one with hooks of its own.
const purify = DOMPurify(window);
purify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName === "style") node.textContent = inertCss(node.textContent ?? "");
});
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (LOADS.has(data.attrName) || (LINKS.has(data.attrName) && !data.attrValue.startsWith("#"))) {
    data.keepAttr = false;
  } else if (CSS.has(data.attrName)) {
    data.attrValue = inertCss(data.attrValue);
  }
});

let count = 0;

/** The page's colors and font, read now: a diagram drawn after the theme changes picks up the new ones. */
function config(dark: boolean): MermaidConfig {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(`--${name}`).trim();
  return {
    startOnLoad: false,
    // Labels are sanitized and click handlers are off; we sanitize the result again below.
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    darkMode: dark,
    fontFamily: FONT,
    themeVariables: {
      darkMode: dark,
      fontFamily: FONT,
      fontSize: "14px",
      background: token("code"),
      primaryColor: mixHex(token("primary"), token("card"), dark ? 0.16 : 0.1),
      primaryBorderColor: mixHex(token("primary"), token("card"), dark ? 0.45 : 0.6),
      primaryTextColor: token("foreground"),
      secondaryColor: mixHex(token("merged"), token("card"), dark ? 0.16 : 0.1),
      tertiaryColor: token("muted"),
      lineColor: token("primary"),
      textColor: token("foreground"),
      titleColor: token("foreground"),
      edgeLabelBackground: token("code"),
      noteBkgColor: mixHex(token("warning"), token("card"), dark ? 0.16 : 0.14),
      noteBorderColor: mixHex(token("warning"), token("card"), 0.45),
      noteTextColor: token("foreground"),
      pie1: token("chart-1"),
      pie2: token("chart-2"),
      pie3: token("chart-3"),
      pieStrokeColor: token("code"),
      pieOuterStrokeColor: token("code"),
      // Flat, like the rest of the app: no gradient borders or drop shadows.
      useGradient: false,
      dropShadow: "none",
    },
    // What a diagram's front matter or %%{init}%% may not change: Mermaid's own list, then the
    // look (it follows the app's theme) and absolute marker URLs (which the sanitizer drops).
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "theme",
      "themeVariables",
      "themeCSS",
      "darkMode",
      "fontFamily",
      "altFontFamily",
      "arrowMarkerAbsolute",
    ],
  };
}

/** Draws a diagram as sanitized SVG, with the size it was laid out at. Throws Mermaid's error when it can't. */
export async function drawMermaid(source: string, dark: boolean): Promise<Drawn> {
  mermaid.initialize(config(dark));
  count += 1;
  const { svg } = await mermaid.render(`rowrow-mermaid-${count}`, source);
  const clean = purify.sanitize(svg, {
    // Mermaid's HTML labels sit in <foreignObject>.
    ADD_TAGS: ["foreignobject"],
    ADD_ATTR: ["dominant-baseline"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ["img", "image", "video", "audio"],
  });
  const root = new DOMParser().parseFromString(clean, "text/html").querySelector("svg");
  const box =
    root
      ?.getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  const width = Number(root?.getAttribute("width")) || box[2] || 800;
  const height = Number(root?.getAttribute("height")) || box[3] || 600;
  return { svg: clean, width, height };
}
