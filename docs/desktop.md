# rowrow for Mac

A Mac app that is two things: a window onto rowrow servers (this Mac's, a dev box's over
SSH, any you can reach), and the manager of the servers it runs. Agents run in the servers,
never in the app: close its windows or quit it and every agent keeps working (PRINCIPLES.md,
product 2). The decisions behind it are D-030 (an Electron window onto each server's own web
app), D-031 (updates from GitHub Releases), D-032 (server bundles, and one service per profile
shared with the CLI) and D-033 (hosts over SSH).

## Two setups

When you first open it, the app asks where your agents run.

- **On this Mac** (the Mac is your dev machine). The app installs rowrow's server here and
  hands it to launchd, exactly as `rowrow service install` does: it starts when you log in,
  restarts if it crashes, and runs whether or not the app is open. Your phone can connect to
  it too (Settings → Pair a device, over Tailscale or your LAN).
- **On another machine** (the Mac is only a client). Either a machine you reach over SSH (a
  dev box, a cloud VM, a Mac mini): the app puts rowrow's server there and keeps it running,
  the way VS Code's Remote-SSH puts its server on the host. Or a server you can already reach
  (Tailscale, your LAN): sign in with its link.

Both can be true at once: the app holds any number of servers, one window each.

### Next to VS Code

| | VS Code | rowrow for Mac |
| --- | --- | --- |
| Where the UI comes from | the client (the workbench ships in the app) | the server (each server serves its own web app, so client and server never disagree about versions) |
| Remote setup | `~/.vscode-server/bin/<commit>` on the host, over SSH | `~/.rowrow/versions/<version>` on the host, over SSH |
| Remote server's life | started per connection, stops a while after the last one | a user service (systemd, launchd): it outlives every client, because agents do |
| Transport | SSH port forward | SSH port forward (`ssh -N -L`), with the system's ssh and your config |
| Local | extension host beside the app | a launchd service from a bundle the app installed |
| Server version | pinned to the client's | the app's, brought over when no agent is mid-turn; a newer one is used as it is |

## How it's put together

```
 rowrow.app (Electron)
  main process (src/desktop)                              windows
   Shell ── servers.json (credentials sealed in Keychain)   a server's own web app, one per server,
    │                                                        its own session (cookie = this app's
    ├─ ServerController × n                                  device credential)
    │   ├─ HostManager ── LocalHost ── ROWROW_HOME/versions/<v>/bin/rowrow service … (launchd)
    │   │              └─ SshHost ─── ssh host sh -s < script, tar -xzf - (upload)
    │   ├─ Tunnel (ssh -N -L 127.0.0.1:p:127.0.0.1:7373)    the app's pages (rowrow-app://ui):
    │   └─ Connection ── /healthz, /auth/token,              welcome, servers, add, offline
    │                    notify.watch → notifications
    ├─ Updater (electron-updater, GitHub Releases)
    └─ menus, menu bar (who needs you), Dock badge
```

- **A server's window** loads that server's web app from the server, in a session of its own
  (`persist:server-<id>`), with the credential this app holds there set as the web app's
  session cookie. Links elsewhere open in your browser; the page can't open windows, ask for
  permissions (only the clipboard and full screen), or reach the app's API.
- **No title bar** (D-057): every window is `hiddenInset`, the page drawn to the top edge with the
  window buttons over its top-left corner. The web app knows it's in the app by its user agent
  (` rowrow-desktop/<version>`), sets `data-chrome="mac"`, and leaves room for the buttons in the
  sidebar's first row (or the page header when there's no sidebar); that 48px band drags the
  window. A server's page from before that gets a 28px strip on top instead. The title (Window
  menu, Mission Control) is the page's, with the server's name only when there are several.
- **The app's own pages** (src/desktop/ui: React and src/web's components) are served from
  `rowrow-app://ui`, and only they get `window.rowrow` (the preload checks the page's origin,
  and the main process checks every call's sender again).
- **The credential**: the app pairs with each server like the iOS app (a one-time code traded
  for a bearer token at `POST /auth/token`, device kind `app`, named "rowrow for Mac (<name>)").
  It mints the code itself where it can (`rowrow pair` on this Mac or over SSH); a URL server
  takes a link from you. A server from before `/auth/token` is signed into through its
  `/auth/redeem` page, in the window's session, and the app uses that cookie. Revoke it on the
  server (Settings → Devices) and the app signs in again where it can mint a code, or says it
  was signed out.
- **Notifications** come from `notify.watch` (D-030): the server decides what to say and when,
  exactly as for Web Push (after a short delay, and not to a device with a focused window), and
  the app shows it as a macOS notification with Reply and Mark as Seen. When an agent is seen
  anywhere, its notification goes. The menu bar and the Dock count the agents that need you.
- **Reconnecting** (PRINCIPLES.md, engineering 2): each server's connection retries with backoff
  forever, at once when the Mac wakes, and reloads the server's windows when the server
  restarted (an upgrade brings a new web app).

## The server and the CLI (D-032)

There is one service per profile, whoever installs it: `rowrow service install` from npm, from
a checkout, or from a server bundle the app put in `~/.rowrow/versions`. The last install wins,
and nothing is lost by switching: the data is the profile's directory (`~/.rowrow/default`),
whichever copy of rowrow runs.

The app never writes launchd plists or systemd units itself. On a host it manages, it runs the
CLI of the bundle it installed there, the same commands you would type:

| The app | runs on the host |
| --- | --- |
| looks | `rowrow service status --json` (what runs, whose, which version) |
| sets up | `rowrow service install --json` |
| upgrades | `rowrow service install --json --if-idle <the service's own flags>` |
| starts, stops, restarts | `rowrow service start\|stop\|restart` |
| signs itself in | `rowrow pair "rowrow for Mac (…)" --json` |

What it does depends on who runs the server there:

| Who runs it | What the app does |
| --- | --- |
| a bundle the app installed | connects, and keeps it at the app's version (below) |
| `rowrow service install` from npm, pnpm or a checkout | connects; says it's yours to update; **Let this app run it** hands it over (keeping its flags, never onto an older version) |
| `rowrow serve` in a terminal | connects; leaves it alone (stop it there to let the app run it) |
| nothing | **Set up** installs the service from the app's bundle |

The `rowrow` command: `~/.rowrow/bin/rowrow` points at the CLI of the bundle the default
profile's service runs (`service install` moves it), and **Install the rowrow Command** links
`/usr/local/bin/rowrow` to it, so the command in your terminal always matches this Mac's
server. Agents get their server's own CLI first on their PATH either way (the server writes
`<profile>/bin/rowrow` at every start).

## Updates

**The app** (D-031) updates itself from GitHub Releases with electron-updater: it checks 15
seconds after it starts, every 4 hours and after the Mac wakes, downloads in the background
(only the changed blocks, after the first update), and installs:

- when you choose **Restart to Update** (menu, menu bar, or the Servers window);
- by itself when no rowrow window is visible and the Mac has been idle for 10 minutes; it comes
  back as it was, in the menu bar;
- whenever the app quits anyway.

What would stop an update from ever installing, and what the app does about it:

- *A window that doesn't close.* Squirrel.Mac installs only after the app quits, and the app
  quits only once every window has closed. Windows close for real (the app stays in the menu
  bar without them), quitting is a flag set on `before-quit` and on Squirrel's own
  `before-quit-for-update`, and a page's `beforeunload` can't cancel it (`will-prevent-unload`).
- *Something still running from the app bundle.* Squirrel swaps the bundle when the app exits.
  This Mac's server runs from `~/.rowrow/versions/<version>`, never from inside the app, and
  SSH tunnels are `/usr/bin/ssh` children that exit with the app.
- *A host operation cut off halfway.* The update waits for one in progress (installing a
  service, upgrading a server) before it quits the app.
- *The app on a disk image or translocated.* The app offers to move itself to /Applications on
  first launch; an update that can't replace it says so, with what to do.
- *A signature that doesn't match.* Squirrel accepts an update only if it's signed like the
  running app: releases are signed with one Developer ID and notarized; the bundle id never
  changes.

**A server** the app runs (this Mac's, or an SSH host's) follows the app: after the app
updates, it installs its bundle next to the old one and asks the host's CLI to switch the
service with `--if-idle`. A restart ends every run (D-010: conversations resume on the next
message, but a turn in progress would be cut off), so while any agent is mid-turn the CLI
refuses (exit code 75) and the app waits, saying which agents it waits for, and tries again
whenever an agent finishes, or when you press **Restart now**. An upgrade that fails puts the
previous server back at once and says why (the app doesn't try again by itself until you press
**Try again** or it starts again). The old bundle stays until the next upgrade, to go back to. A
server newer than the app is left as it is.

## SSH hosts (D-033)

**Add an SSH host** takes a host from `~/.ssh/config` or `user@host`. The app:

1. connects with the system's ssh, never asking for anything (`BatchMode`): your keys, agent,
   ProxyJump and config apply; a host you've never connected to needs one `ssh <host>` in a
   terminal first, to trust its key;
2. looks at the host (`uname`, `~/.rowrow/versions`) and uploads the server bundle for it
   (Linux x64 or arm64 with glibc, or an Apple silicon Mac) into `~/.rowrow/versions/<version>`
   if it isn't there: the bundle comes from the release on GitHub, checked against the
   release's `SHA256SUMS`, and is uploaded over SSH, so the host needs no internet access or
   Node of its own;
3. runs `rowrow service install` there (systemd `--user` on Linux, launchd on a Mac). A host
   with no user service manager (a container, WSL) gets the server started in the background
   instead, and the app says it won't survive a reboot. On Linux a user service stops at logout
   unless lingering is on: `loginctl enable-linger $USER` on the host;
4. forwards a port on this Mac to the server's port on the host (`ssh -N -L`, the same local
   port every time), signs itself in with `rowrow pair` there, and opens the window.

The server stays on the host when the app quits or the Mac sleeps; the tunnel comes back with
the Mac. Your phone reaches that server the way it would anyway (Tailscale on the host), not
through this Mac.

## Security

- The app is signed with a Developer ID and notarized, with the hardened runtime
  (`desktop/entitlements.plist`: JIT, and library validation off for the server's native
  addons). Electron's fuses are set so the app can't be used to run other code with its
  signature: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, the app's code only
  from its asar, checked against the hash in Info.plist, and cookies encrypted with a key in
  the Keychain.
- Credentials: one device credential per server, sealed with Electron's safeStorage (the
  Keychain) in the app's data; the same one is the window's session cookie. Removing a server
  revokes it there.
- A server's pages get no Node, no app API (sandboxed, context-isolated), and no permissions
  beyond copying to the clipboard and full screen.

## Development

```bash
pnpm desktop                 # build and run the app from this checkout (see below)
pnpm build:desktop           # dist/desktop: the main process, the preload, the app's pages
pnpm build:bundle            # dist/bundles: this Mac's server bundle (--target linux-x64,linux-arm64 for others)
pnpm package:desktop         # dist/desktop-release/mac-arm64/rowrow.app, signed ad hoc
pnpm package:desktop --pack  # … plus the zip, the disk image, blockmaps and latest-mac.yml
```

`pnpm desktop` runs the app on a throwaway home in `.dev/desktop`, with this checkout's server
as the app's own child process instead of a launchd service, the scripted runtime, and its own
app data: your rowrow, your launchd and an installed rowrow.app are untouched. It downloads
Electron the first time (`pnpm install` doesn't).

The app reads these (none is needed by a packaged app):

| Variable | |
| --- | --- |
| `ROWROW_HOME` | as everywhere (`~/.rowrow`) |
| `ROWROW_DESKTOP_PROFILE`, `ROWROW_DESKTOP_PORT` | the profile the app runs on this Mac and SSH hosts, and a port for a profile other than `default` |
| `ROWROW_DESKTOP_SUPERVISOR=child` | the server as the app's child process, not a launchd service |
| `ROWROW_DESKTOP_SERVER`, `ROWROW_DESKTOP_NODE` | the server to run: a bundle, or a checkout with the Node to run it |
| `ROWROW_DESKTOP_TEST_RUNTIME=1` | serve with the scripted runtime |
| `ROWROW_DESKTOP_BUNDLES` | directories of `rowrow-server-<v>-<target>.tar.gz` to upload to SSH hosts before asking GitHub |
| `ROWROW_DESKTOP_SSH` | the `ssh` to run (a wrapper with its own config, for tests) |
| `ROWROW_DESKTOP_UPDATE_URL` | a directory with `latest-mac.yml` to update from, instead of GitHub Releases |
| `ROWROW_DESKTOP_USER_DATA` | the app's data (and logs), instead of `~/Library/Application Support/rowrow` |
| `ROWROW_DESKTOP_MOCK_KEYCHAIN=1` | with `ROWROW_DESKTOP_USER_DATA`: a stand-in for the Keychain (tests of a packaged app) |
| `ROWROW_DESKTOP_PLAIN_TOKENS=1` | an unpackaged app keeps credentials unsealed (development) |
| `ROWROW_DESKTOP_NO_MOVE=1` | don't offer to move the app to /Applications |

Where to look: the app's log is `~/Library/Logs/rowrow/desktop.jsonl` (Help → Show the App's
Log): `desktop.host.*`, `desktop.connection.*`, `desktop.tunnel.*`, `desktop.update.*`. A
server's own log and `rowrow logs` work as always.

Tests: the pure parts (`src/desktop/*.test.ts`: planning, SSH scripts run by a real `sh`, the
server list) and the server side (`test/desktop.test.ts`: notify.watch, and the app's
connection against a real server) run in `pnpm check`. `pnpm package:desktop --inspectable`
builds an app Playwright can drive (Node's inspector left on); never ship one.

## Releases and signing

A version tag (AGENTS.md → Releasing) builds everything in `.github/workflows/release.yml`:

1. **server bundles** for linux-x64, linux-arm64 and darwin-arm64, from the npm tarball the
   release publishes (no secrets);
2. **the app**, unsigned, on a Mac runner (no secrets);
3. **signing** (`.github/actions/mac-sign`): `desktop/sign.sh` with the Developer ID
   certificate, notarization with `notarytool`, stapling, then `desktop/pack.sh` for the zip
   and the disk image, itself signed and notarized. This job holds the certificate and the App
   Store Connect key, and installs nothing from npm;
4. **metadata**: blockmaps and `latest-mac.yml`, made from the signed files (no secrets);
5. **publish**: npm, then one GitHub release with every file and `SHA256SUMS`, so the updater
   never sees a release without its `latest-mac.yml`.

Without `MACOS_CERT_P12_BASE64` the app is built but not signed or released (a fork's tags
still publish the server and the bundles).

rowrow for Mac is signed with **Botiverse, Inc.**'s Developer ID (team `XDAPXFY8FZ`), the
certificate Botiverse's other macOS apps use, under the same secret names (botiverse/slock's
`_macos-sign-notarize.yml`). It is notarized with its own App Store Connect team key, "rowrow
notarization": Developer access, the least `notarytool` needs, and revocable without touching
the other apps. GitHub keeps secrets per repository and never shows them again, so they are
set here from the files they came from:

```bash
base64 -i developer-id-application.p12 | gh secret set MACOS_CERT_P12_BASE64 -R xxchan/rowrow
gh secret set MACOS_CERT_PASSWORD -R xxchan/rowrow           # the .p12's password (asks for it)
gh secret set APPLE_TEAM_ID -R xxchan/rowrow                 # Botiverse's team id
gh secret set APPLE_API_KEY_ID -R xxchan/rowrow              # the "rowrow notarization" key's id
gh secret set APPLE_API_ISSUER_ID -R xxchan/rowrow
gh secret set APPLE_API_PRIVATE_KEY -R xxchan/rowrow < AuthKey_<key id>.p8
```

The signing job refuses a certificate that isn't a Developer ID Application of `APPLE_TEAM_ID`.
To try signing without a release: Actions → desktop → Run workflow (`gh workflow run
desktop.yml -R xxchan/rowrow`); the run's `rowrow-mac-signed` artifact is the notarized zip and
disk image. For another team, the same names with your own certificate and key work as well.

**The certificate expires on 2027-02-01.** Apple's previous Developer ID intermediate issued
it, and nothing it issued outlives it. Before then, Botiverse's Account Holder (only the
Account Holder can create a Developer ID certificate) makes a new one under the G2
intermediate, which lasts five years, and the two certificate secrets are replaced, here and
in slock. Installed apps keep updating across the change: Squirrel checks an update against
the app's designated requirement, which names the team, not the certificate. Released
versions keep opening after the date, since they are notarized and timestamped.

The bundle id is `io.github.xxchan.rowrow.mac` (`MAC_BUNDLE_ID` to use your own). Changing it,
or the signing team, after a release strands every installed app on its version: Squirrel
takes an update only when it's signed like the app that asks.

## Limits and what's next

- Apple silicon only: macOS 26 was the last release for Intel Macs, and one architecture keeps
  the download smaller. Linux and Windows desktops aren't planned; there the web app is the app.
- The download is large (Electron plus a server with its own Node): about 200 MB compressed.
  Updates after the first download only what changed.
- SSH hosts need key authentication (no password or 2FA prompts yet) and a glibc Linux or an
  Apple silicon Mac.
- Reaching this Mac's server from your phone still means setting up Tailscale (or `--host`)
  yourself; the app could offer it.
- Nothing yet shows a server's own notifications preferences or the phone's pairing QR outside
  the web app.
