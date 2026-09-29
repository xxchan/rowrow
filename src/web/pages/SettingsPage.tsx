// Settings: this device (theme, notifications, sign out), your other devices (pair one with
// a QR code, revoke), the agent runtimes installed on the server, and what the server is.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Info, Plus, TriangleAlert, X } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppState, Device, LoginLink } from "../../shared/schemas.ts";
import { PageHeader } from "../components/Shell.tsx";
import { AgentIcon } from "../components/AgentIcon.tsx";
import { StatusDot } from "../components/StatusDot.tsx";
import { ago } from "../lib/format.ts";
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
            title="Quick replies"
            description="One tap puts one in the composer, ready to edit or send. On every device."
          >
            <QuickReplies
              replies={state.settings.quickReplies}
              onChange={(quickReplies) =>
                void run("Save", async () => client?.settings.update({ quickReplies }))
              }
            />
          </Section>

          <Section
            title="Notifications on this device"
            description="You're notified when an agent finishes or needs you, unless you're looking at it."
          >
            {support === "insecure" ? (
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

          <Section
            title="Devices"
            action={
              <Button
                size="sm"
                onClick={() =>
                  void run("Pair", async () => setPairing((await client?.devices.pair({})) ?? null))
                }
              >
                Pair a device
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
                      {`${device.kind === "cli" ? "command line" : device.kind === "app" ? "iOS app" : "browser"}${device.push ? " · notifications on" : ""} · last seen ${device.lastSeenAt === null ? "never" : `${ago(device.lastSeenAt)} ago`}`}
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
                onClick={() => void run("Refresh", async () => client?.runtimes.list({ refresh: true }))}
              >
                Check again
              </Button>
            }
          >
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {Object.values(state.runtimes).map((runtime) => (
                <li key={runtime.id} className="flex items-center gap-3 px-3 py-2.5">
                  <StatusDot
                    tone={runtime.installed ? "success" : "neutral"}
                    label={runtime.installed ? "Installed" : "Not installed"}
                  />
                  <AgentIcon runtime={runtime.id} label={runtime.name} />
                  <span className="text-sm font-medium">{runtime.name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {runtime.installed
                      ? (runtime.version ?? "installed")
                      : (runtime.reason ?? "not installed")}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Server">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
              <Fact label="Machine">{host.name}</Fact>
              <Fact label="Version">
                {`rowrow ${host.version} · oar ${host.oar} · node ${host.node}`}
                {host.update !== null && (
                  <span className="block text-muted-foreground">
                    {`rowrow ${host.update.version} is out: `}
                    <code className="font-mono text-xs break-all text-foreground">{host.update.command}</code>
                    {host.update.after === null ? "" : ` ${host.update.after}`}
                  </span>
                )}
              </Fact>
              <Fact label="Address">
                {host.url + (host.exposed ? " (reachable beyond this machine)" : " (this machine only)")}
              </Fact>
              <Fact label="Data">
                <code className="font-mono text-xs">{host.dataDir}</code>
              </Fact>
              <Fact label="Running since">{new Date(host.startedAt).toLocaleString()}</Fact>
            </dl>
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
      <PairDialog link={pairing} onClose={() => setPairing(null)} />
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
    <section className="flex flex-col gap-3">
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

function QuickReplies({
  replies,
  onChange,
}: {
  replies: readonly string[];
  onChange: (replies: string[]) => void;
}) {
  const [adding, setAdding] = useState("");
  const add = (): void => {
    const text = adding.trim();
    if (text === "" || replies.includes(text)) return;
    onChange([...replies, text]);
    setAdding("");
  };
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {replies.map((reply) => (
          <li key={reply} className="flex items-center gap-2 py-1 pr-1 pl-3">
            <span className="min-w-0 flex-1 truncate text-sm">{reply}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={`Remove “${reply}”`}
              onClick={() => onChange(replies.filter((r) => r !== reply))}
            >
              <X />
            </Button>
          </li>
        ))}
        {replies.length === 0 && <li className="px-3 py-2.5 text-sm text-muted-foreground">None yet.</li>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label="New quick reply"
          placeholder="Add a reply you send often"
          value={adding}
          maxLength={500}
          onChange={(event) => setAdding(event.currentTarget.value)}
        />
        <Button type="submit" variant="outline" disabled={adding.trim() === "" || replies.length >= 24}>
          <Plus /> Add
        </Button>
      </form>
    </div>
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

function PairDialog({ link, onClose }: { link: LoginLink | null; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (link === null) return;
    void QRCode.toString(link.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg);
  }, [link]);
  return (
    <Dialog open={link !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            Scan with the phone's camera, or open the link on the other device.
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
              rowrow listens on 127.0.0.1. To pair a phone, run the server where the phone can reach it (for
              example behind tailscale serve) and start it with --public-url.
            </Callout>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
