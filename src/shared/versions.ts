// rowrow's versions are semver (package.json's). Compared by the server's update check
// (D-025) and by the Mac app, which decides whether a host's server is older than its own
// (D-032).

type Version = { readonly core: readonly number[]; readonly pre: readonly (number | string)[] };

function parse(version: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
  };
}

export function isVersion(version: string): boolean {
  return parse(version) !== null;
}

/** 0.3.0-rc.1, not 0.3.0. */
export function isPrerelease(version: string): boolean {
  return (parse(version)?.pre.length ?? 0) > 0;
}

/** Semver precedence: negative when a < b. Versions that don't parse compare equal. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
