// Settings: this device (theme, notifications, sign out), the devices signed in to this machine
// (sign another in with a QR code, revoke), the agent runtimes installed here, and what this
// machine runs. In rowrow for Mac, also the machines the app knows (D-059): a machine is where
// agents run, a device is what you steer them from.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Info, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { appName, Settings, type AppState, type Device, type LoginLink } from "../../shared/schemas.ts";
import { MachineList } from "../components/Machines.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { RuntimeList, useRuntimeUpdates } from "../components/RuntimeList.tsx";
import { UsageList, useUsage } from "../components/UsageList.tsx";
import { UpdateStatus } from "../components/UpdateStatus.tsx";
import { ago } from "../lib/format.ts";
import { askApp, useMachines, type MachinesBridge } from "../lib/mac-app.ts";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../lib/push.ts";
import type { Route } from "../lib/router.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";
import { setThemeMode, useTheme, type ThemeMode } from "../lib/theme.ts";

export function SettingsPage({ route }: { route: Route }) {
  const state = useApp((s) => s.state) as AppState;
  const client = useClient();
  const theme = useTheme();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [pairing, setPairing] = useState<LoginLink | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const machines = useMachines();

  const loadDevices = useCallback(async () => {
    if (client === null) return;
    setDevices(await client.devices.list());
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = client === null ? null : await client.devices.list();
        const subscription = await currentSubscription();
        if (cancelled) return;
        if (list !== null) setDevices(list);
        setSubscribed(subscription !== null);
      } catch (error) {
        report("warn", "devices.load_failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      toast.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      report("warn", "settings.action_failed", error, { action: label });
    }
  };

  const runtimeUpdates = useRuntimeUpdates();
  const usage = useUsage();
  const support = pushSupport();
  const { host } = state;
  return (
    <>
      <PageHeader title="Settings" route={route} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-3 py-4 md:px-6 md:py-6">
          <Section title="Appearance" description="On this device.">
            <Tabs value={theme.mode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
              <TabsList aria-label="Theme">
                <TabsTrigger value="system">System</TabsTrigger>
                <TabsTrigger value="light">Light</TabsTrigger>
                <TabsTrigger value="dark">Dark</TabsTrigger>
              </TabsList>
            </Tabs>
          </Section>

          <Section
            title="Notifications on this device"
            description="You're notified when an agent finishes or needs you, unless you're looking at it."
          >
            {support === "desktop" ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  The rowrow app shows this machine's notifications while it runs, in the menu bar when its
                  windows are closed. Turn on "Open rowrow when you log in" in its Machines window to keep
                  them coming.
                </p>
                <Button variant="outline" onClick={() => void run("Test", async () => client?.notify.test())}>
                  Send a test
                </Button>
              </div>
            ) : support === "insecure" ? (
              <Callout icon={<Info />} title="Notifications need HTTPS">
                Browsers only allow push notifications on HTTPS pages (or localhost). Serve rowrow over HTTPS,
                for example with tailscale serve or --tls-cert.
              </Callout>
            ) : support === "unsupported" ? (
              <Callout icon={<Info />} title="This browser can't receive push notifications">
                On iPhone and iPad, add rowrow to the Home Screen first, then open it from there.
              </Callout>
            ) : subscribed === true ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void run("Test", async () => client?.notify.test())}>
                  Send a test
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run("Turn off", async () => {
                      if (client !== null) await disablePush(client);
                      setSubscribed(false);
                    })
                  }
                >
                  Turn off
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  disabled={client === null || host.pushKey === null}
                  onClick={() =>
                    void run("Turn on notifications", async () => {
                      if (client !== null && host.pushKey !== null) await enablePush(client, host.pushKey);
                      setSubscribed(true);
                      await loadDevices();
                    })
                  }
                >
                  Turn on notifications
                </Button>
              </div>
            )}
          </Section>

          {machines !== null && (
            <Section
              title="Machines"
              description="Where your agents run, as this app knows them. Each machine has its own agents, workspaces and settings."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => askApp("Opening rowrow", () => machines.bridge.showMachines("add"))}
                >
                  <Plus /> Add a machine
                </Button>
              }
            >
              <MachineList bridge={machines.bridge} list={machines.list} />
            </Section>
          )}

          <Section
            title="Signed-in devices"
            description="Phones, browsers and apps that can see and steer this machine's agents."
            action={
              <Button
                size="sm"
                onClick={() =>
                  void run("Sign in another device", async () =>
                    setPairing((await client?.devices.pair({})) ?? null),
                  )
                }
              >
                Sign in another device
              </Button>
            }
          >
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {(devices ?? []).map((device) => (
                <li key={device.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {device.name}
                      {device.current && (
                        <span className="font-normal text-muted-foreground"> (this device)</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {`${device.kind === "cli" ? "command line" : device.kind === "app" ? "app" : "browser"}${device.push ? " · notifications on" : ""} · last seen ${device.lastSeenAt === null ? "never" : `${ago(device.lastSeenAt)} ago`}`}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run("Revoke", async () => {
                        if (device.current) {
                          await fetch("/auth/logout", { method: "POST" });
                          location.reload();
                          return;
                        }
                        await client?.devices.revoke({ id: device.id });
                        await loadDevices();
                      })
                    }
                  >
                    {device.current ? "Sign out" : "Revoke"}
                  </Button>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            title="Agent runtimes"
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={runtimeUpdates.checking}
                onClick={runtimeUpdates.recheck}
              >
                {runtimeUpdates.checking && <LoaderCircle className="animate-spin" />}
                Check again
              </Button>
            }
          >
            <RuntimeList runtimes={Object.values(state.runtimes)} updates={runtimeUpdates} />
          </Section>

          <Section
            title="Subscription usage"
            description="How much of each plan's limits is left, read every 5 minutes. The marker on each bar is where an even burn would be."
            action={
              <Button size="sm" variant="outline" disabled={usage.checking} onClick={usage.recheck}>
                {usage.checking && <LoaderCircle className="animate-spin" />}
                Check now
              </Button>
            }
          >
            <UsageList usage={usage} runtimes={state.runtimes} />
          </Section>

          <Section title="This machine">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
              <Fact label="Name">{host.name}</Fact>
              <Fact label="Version">
                {`rowrow ${host.version} · oar ${host.oar} · node ${host.node}`}
                <UpdateStatus host={host} />
              </Fact>
              <Fact label="Address">
                {host.url + (host.exposed ? " (reachable beyond this machine)" : " (this machine only)")}
              </Fact>
              <Fact label="Data">
                <code className="font-mono text-xs">{host.dataDir}</code>
              </Fact>
              <Fact label="Running since">{new Date(host.startedAt).toLocaleString()}</Fact>
            </dl>
            <InstanceName saved={state.settings.instanceName} />
            <div className="flex items-center gap-3">
              <Switch
                id="check-for-updates"
                checked={state.settings.checkForUpdates}
                disabled={client === null}
                onCheckedChange={(checkForUpdates) =>
                  void run("Save", async () => client?.settings.update({ checkForUpdates }))
                }
              />
              <Label htmlFor="check-for-updates" className="flex-col items-start gap-0.5 font-normal">
                <span className="text-sm">Check for updates</span>
                <span className="text-xs text-muted-foreground">
                  The server asks the npm registry twice a day whether a newer rowrow is out.
                </span>
              </Label>
            </div>
          </Section>
        </div>
      </div>
      <PairDialog link={pairing} machines={machines?.bridge ?? null} onClose={() => setPairing(null)} />
    </>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description !== undefined && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The title suffix (roamgate #368): "rowrow · Work" names this server's tabs and its installed
 * app, so they don't read like your other servers'. Kept on the server, for every device.
 */
function InstanceName({ saved }: { saved: string }) {
  const client = useClient();
  // null: not edited, so it shows what's saved (also when another device changes it).
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "failed"; message: string } | null>(null);
  const value = draft ?? saved;
  const parsed = Settings.shape.instanceName.safeParse(value);
  const next = parsed.success ? parsed.data : null;
  const changed = next !== null && next !== saved;
  const saving = status?.kind === "saving";
  const save = async (instanceName: string): Promise<void> => {
    if (client === null) return;
    setStatus({ kind: "saving", message: "Saving…" });
    try {
      await client.settings.update({ instanceName });
      setDraft(null);
      setStatus({ kind: "saved", message: "Saved for this machine." });
    } catch (error) {
      setStatus({
        kind: "failed",
        message: `Couldn't save: ${error instanceof Error ? error.message : String(error)}`,
      });
      report("warn", "settings.action_failed", error, { action: "Save the title suffix" });
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !saving) void save(next);
      }}
    >
      <div className="flex flex-col gap-0.5">
        <Label htmlFor="instance-name" className="font-normal">
          App and webpage title suffix
        </Label>
        <p id="instance-name-about" className="text-xs text-muted-foreground">
          Saved on this machine and shared by every device signed in to it. Your other machines keep their own
          names.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          id="instance-name"
          className="min-w-0 basis-full sm:basis-0 sm:flex-1"
          placeholder="For example, Work or Home"
          spellCheck={false}
          autoComplete="off"
          value={value}
          aria-invalid={!parsed.success}
          aria-describedby="instance-name-about instance-name-hint"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (!saving) setStatus(null);
          }}
        />
        <Button type="submit" variant="outline" disabled={client === null || saving || !changed}>
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={client === null || saving || (saved === "" && value === "")}
          onClick={() => {
            setDraft(null);
            void save("");
          }}
        >
          Reset to default
        </Button>
      </div>
      {parsed.success ? (
        <p id="instance-name-hint" className="text-xs text-muted-foreground">
          Up to 32 characters. Extra spaces are trimmed. Leave empty for the default name, rowrow.
        </p>
      ) : (
        <p id="instance-name-hint" role="alert" className="text-xs text-destructive">
          {parsed.error.issues[0]?.message}
        </p>
      )}
      <div className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">
        <p>
          <span className="text-muted-foreground">Saved name: </span>
          <span className="font-medium">{appName(saved)}</span>
        </p>
        {changed && (
          <p>
            <span className="text-muted-foreground">Preview (not saved): </span>
            <span className="font-medium">{appName(next)}</span>
          </p>
        )}
      </div>
      {status !== null && (
        <p
          role={status.kind === "failed" ? "alert" : "status"}
          className={cn("text-xs", status.kind === "failed" ? "text-destructive" : "text-muted-foreground")}
        >
          {status.message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Save it before installing rowrow as an app (Add to Home Screen). An app installed earlier may keep its
        old name until you install it again.
      </p>
    </form>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Callout({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border bg-muted/50 px-3 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

/**
 * A one-time link that signs another device in to this machine. It doesn't add a machine: that's
 * where agents run, added in rowrow for Mac (D-059), and the dialog says so.
 */
function PairDialog({
  link,
  machines,
  onClose,
}: {
  link: LoginLink | null;
  machines: MachinesBridge | null;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (link === null) return;
    void QRCode.toString(link.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg);
  }, [link]);
  return (
    <Dialog open={link !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in another device</DialogTitle>
          <DialogDescription>
            Scan with the phone's camera, or open the link on the other device. It can then see and steer this
            machine's agents.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {svg !== null && (
            <div className="size-60 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
          )}
          <p className="text-xs text-muted-foreground">{`Works once, for 10 minutes (until ${link === null ? "" : new Date(link.expiresAt).toLocaleTimeString()}).`}</p>
          <code className="max-w-full rounded bg-muted px-2 py-1 font-mono text-xs break-all">
            {link?.url ?? ""}
          </code>
          {link !== null && new URL(link.url).hostname === "127.0.0.1" && (
            <Callout icon={<TriangleAlert />} title="This address only works on this machine">
              rowrow listens on 127.0.0.1. To sign in a phone, run rowrow where the phone can reach it (for
              example behind tailscale serve) and start it with --public-url.
            </Callout>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {machines === null
            ? "To run agents on another machine, add it in rowrow for Mac, or run rowrow there and sign in to it."
            : "To run agents on another machine, add it to this app instead."}
          {machines !== null && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => {
                onClose();
                askApp("Opening rowrow", () => machines.showMachines("add"));
              }}
            >
              Add a machine…
            </Button>
          )}
        </p>
      </DialogContent>
    </Dialog>
  );
}
