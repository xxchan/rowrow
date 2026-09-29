// Agent CLIs live wherever the user installed them (Homebrew, ~/.local/bin, nvm, bun…).
// A server started from a service manager or an app has a bare PATH, so borrow the one a
// login shell would have. Entries already on PATH keep their order; missing ones are
// appended.
import { execFile } from "node:child_process";
import path from "node:path";
import { log } from "./telemetry/log.ts";

export async function augmentPathFromLoginShell(): Promise<void> {
  const shell = process.env["SHELL"];
  if (shell === undefined || process.platform === "win32") return;
  const marker = "__ROWROW_PATH__";
  const output = await new Promise<string | null>((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '${marker}%s${marker}' "$PATH"`],
      { timeout: 5000, env: process.env },
      (error, stdout) => {
        resolve(error === null ? stdout : null);
      },
    );
  });
  const match = output === null ? null : new RegExp(`${marker}(.*)${marker}`, "s").exec(output);
  if (match?.[1] === undefined) {
    log.warn("shell.path_unavailable", { shell });
    return;
  }
  const current = (process.env["PATH"] ?? "").split(path.delimiter).filter((p) => p !== "");
  const added = match[1].split(path.delimiter).filter((p) => p !== "" && !current.includes(p));
  if (added.length > 0) {
    process.env["PATH"] = [...current, ...added].join(path.delimiter);
    log.info("shell.path_augmented", { added });
  }
}
