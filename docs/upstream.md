# Upstream issues and workarounds

When rowrow works around a gap in a dependency instead of fixing it there, the gap is
listed here with its upstream fix, so the workaround can be deleted when the fix lands
(PRINCIPLES.md, engineering 6).

| Where | Gap | Workaround in rowrow | Upstream |
| --- | --- | --- | --- |
| npm 11, and `@earendil-works/pi-coding-agent` (through oar) | npm 11 (seen with 11.12.1; npm 10.9 filters them) installs every optional package a dependency's `npm-shrinkwrap.json` lists, whatever its `os` and `cpu`, with or without `--os`/`--cpu`. pi-coding-agent 0.87.1's lists esbuild for 26 platforms: about 280 MB in every install, where one platform's 11 MB is used | `scripts/build-bundle.ts` removes packages whose `os` or `cpu` rules out the bundle's platform, so the Mac app and the SSH bundles carry one esbuild. `npm install -g rowrow` with npm 11 still gets all 26 | Not reported yet: npm filtering them again, or pi-coding-agent dropping the shrinkwrap, fixes every install |
