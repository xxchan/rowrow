import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LOCAL_ID, ServerStore, type Sealer } from "./servers.ts";

const rot13: Sealer = {
  seal: (text) => Buffer.from(text).reverse().toString("base64"),
  open: (sealed) => Buffer.from(sealed, "base64").reverse().toString(),
};

test("servers survive a restart, with credentials sealed on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rowrow-servers-"));
  const file = path.join(dir, "servers.json");
  const store = new ServerStore(file, rot13);
  store.add({
    id: LOCAL_ID,
    name: "This Mac",
    kind: "local",
    profile: "default",
    destination: null,
    url: null,
    localPort: null,
    background: false,
    token: "rr_secret",
  });
  const devbox = store.add({
    name: "devbox",
    kind: "ssh",
    profile: "default",
    destination: "devbox",
    url: null,
    localPort: 49200,
    background: false,
    token: null,
  });
  store.update(devbox.id, { token: "rr_other" });

  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(file, "utf8")).not.toContain("rr_secret");
  const again = new ServerStore(file, rot13);
  expect(again.list().map((s) => [s.id, s.token])).toEqual([
    [LOCAL_ID, "rr_secret"],
    [devbox.id, "rr_other"],
  ]);

  // A credential another key sealed (a backup restored elsewhere) is dropped, not fatal.
  const other = new ServerStore(file, {
    seal: (t) => t,
    open: () => {
      throw new Error("wrong key");
    },
  });
  expect(other.get(LOCAL_ID)?.token).toBeNull();
  again.remove(devbox.id);
  expect(new ServerStore(file, rot13).list().map((s) => s.id)).toEqual([LOCAL_ID]);
  fs.rmSync(dir, { recursive: true, force: true });
});
