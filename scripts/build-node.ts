// `pnpm build:node`: the server and the CLI as plain JavaScript in lib/, for the npm package
// (docs/decisions.md, D-018). Node won't strip types under node_modules, so an installed
// package can't run src/ the way a checkout does.
//
// Each module the CLI imports, from src/{cli,server,shared}, becomes lib/**/*.js at the same
// depth. Node's own stripper replaces every type with spaces, and each relative `.ts`
// specifier becomes `.js`, which is just as long, so every line and column in lib/ is where it
// is in src/: a stack trace from the package points at the source without source maps.
// Nothing is bundled; dependencies stay external and npm installs them from package.json.
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lib = path.join(root, "lib");
const DIRS = ["cli", "server", "shared"];
const ENTRY = path.join(lib, "cli", "main.js");

/**
 * A relative `.ts` specifier: after `from` (static imports and re-exports), or after `import`
 * (side-effect imports) or `import(` (dynamic imports). Type-only imports are spaces by the
 * time this runs.
 */
const TS_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'`])(\.{1,2}\/[^"'`\r\n]*)\.ts\2/g;
/** Any relative specifier in the output. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'`])(\.{1,2}\/[^"'`\r\n]*)\1/g;

/** One module as JavaScript, of the same length: every line and column stays put. */
export function toJavaScript(source: string): string {
  // No `sourceUrl` option: it appends a comment naming this machine's path. A leading shebang
  // survives as it is.
  return stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
    TS_SPECIFIER,
    (_match, before: string, quote: string, specifier: string) => `${before}${quote}${specifier}.js${quote}`,
  );
}

function compile(file: string): string {
  try {
    return toJavaScript(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`build:node: can't strip the types of ${path.relative(root, file)}`, { cause: error });
  }
}

function build(): void {
  fs.rmSync(lib, { recursive: true, force: true });
  const modules = new Map<string, string>();
  for (const dir of DIRS) {
    const from = path.join(root, "src", dir);
    for (const name of fs.readdirSync(from, { recursive: true, encoding: "utf8" })) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      modules.set(path.join(lib, dir, name.replace(/\.ts$/, ".js")), compile(path.join(from, name)));
    }
  }

  // Ship what the CLI imports, following every relative import from its main: that leaves
  // out tests' helpers, and each import has to land on a module of the package. A `.ts`
  // specifier the rewrite missed, or an import from outside src/{cli,server,shared}, fails the
  // build instead of someone's `npm install -g`.
  const shipped = new Map<string, string>();
  const problems: string[] = [];
  const pending = [ENTRY];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const code = modules.get(file);
    if (code === undefined) throw new Error(`build:node: no ${path.relative(root, file)}`);
    if (shipped.has(file)) continue;
    shipped.set(file, code);
    for (const [, , specifier = ""] of code.matchAll(RELATIVE_SPECIFIER)) {
      const target = path.resolve(path.dirname(file), specifier);
      if (modules.has(target)) pending.push(target);
      else problems.push(`${path.relative(root, file)}: "${specifier}" is not a module of the package`);
    }
  }
  if (problems.length > 0) throw new Error(`build:node:\n  ${problems.join("\n  ")}`);

  for (const [file, code] of shipped) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code, { mode: code.startsWith("#!") ? 0o755 : 0o644 });
  }
  const unused = [...modules.keys()].filter((file) => !shipped.has(file));
  console.log(
    `build:node: ${shipped.size} modules in lib/${unused.length === 0 ? "" : `; not imported by the CLI: ${unused.map((file) => path.relative(lib, file)).join(", ")}`}`,
  );
}

if (import.meta.main) build();
