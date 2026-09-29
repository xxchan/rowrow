// Settings: this device (notifications, sign out), your other devices (pair one with a QR
// code, revoke), the agent runtimes installed on the server, and what the server is.
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import type { AppState, Device, LoginLink } from "../../shared/schemas.ts";
import { ago } from "../lib/format.ts";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../lib/push.ts";
import { useApp, useClient } from "../lib/store.ts";
import { report } from "../lib/telemetry.ts";

export function SettingsPage() {
  const state = useApp((s) => s.state) as AppState;
  const client = useClient();
  const toast = useToast();
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
      toast({ body: `${label}: ${error instanceof Error ? error.message : String(error)}`, type: "error" });
      report("warn", "settings.action_failed", error, { action: label });
    }
  };

  const support = pushSupport();
  const { host } = state;
  return (
    <Layout
      height="fill"
      padding={4}
      contentWidth={760}
      header={
        <LayoutHeader>
          <Heading level={1}>Settings</Heading>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          <VStack gap={5}>
            <VStack gap={2}>
              <Heading level={3}>Notifications on this device</Heading>
              {support === "insecure" ? (
                <Banner
                  status="info"
                  title="Notifications need HTTPS"
                  description="Browsers only allow push notifications on HTTPS pages (or localhost). Serve rowrow over HTTPS, for example with tailscale serve or --tls-cert."
                />
              ) : support === "unsupported" ? (
                <Banner
                  status="info"
                  title="This browser can't receive push notifications"
                  description="On iPhone and iPad, add rowrow to the Home Screen first, then open it from there."
                />
              ) : (
                <HStack gap={2}>
                  {subscribed === true ? (
                    <>
                      <Button
                        label="Send a test"
                        onClick={() => void run("Test", async () => client?.notify.test())}
                      />
                      <Button
                        label="Turn off"
                        variant="secondary"
                        onClick={() =>
                          void run("Turn off", async () => {
                            if (client !== null) await disablePush(client);
                            setSubscribed(false);
                          })
                        }
                      />
                    </>
                  ) : (
                    <Button
                      label="Turn on notifications"
                      variant="primary"
                      isDisabled={client === null || host.pushKey === null}
                      onClick={() =>
                        void run("Turn on notifications", async () => {
                          if (client !== null && host.pushKey !== null)
                            await enablePush(client, host.pushKey);
                          setSubscribed(true);
                          await loadDevices();
                        })
                      }
                    />
                  )}
                </HStack>
              )}
              <Text type="supporting">
                You're notified when an agent finishes or needs you, unless you're looking at it.
              </Text>
            </VStack>

            <VStack gap={2}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={3}>Devices</Heading>
                <Button
                  label="Pair a device"
                  variant="primary"
                  onClick={() =>
                    void run("Pair", async () => setPairing((await client?.devices.pair({})) ?? null))
                  }
                />
              </HStack>
              <List hasDividers>
                {(devices ?? []).map((device) => (
                  <ListItem
                    key={device.id}
                    label={`${device.name}${device.current ? " (this device)" : ""}`}
                    description={`${device.kind === "cli" ? "command line" : "browser"}${device.push ? " · notifications on" : ""} · last seen ${device.lastSeenAt === null ? "never" : `${ago(device.lastSeenAt)} ago`}`}
                    endContent={
                      <Button
                        label={device.current ? "Sign out" : "Revoke"}
                        size="sm"
                        variant="secondary"
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
                      />
                    }
                  />
                ))}
              </List>
            </VStack>

            <VStack gap={2}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={3}>Agent runtimes</Heading>
                <Button
                  label="Check again"
                  variant="secondary"
                  onClick={() => void run("Refresh", async () => client?.runtimes.list({ refresh: true }))}
                />
              </HStack>
              <List hasDividers>
                {Object.values(state.runtimes).map((runtime) => (
                  <ListItem
                    key={runtime.id}
                    label={runtime.name}
                    description={
                      runtime.installed
                        ? (runtime.version ?? "installed")
                        : (runtime.reason ?? "not installed")
                    }
                    startContent={
                      <StatusDot
                        variant={runtime.installed ? "success" : "neutral"}
                        label={runtime.installed ? "Installed" : "Not installed"}
                      />
                    }
                  />
                ))}
              </List>
            </VStack>

            <VStack gap={2}>
              <Heading level={3}>Server</Heading>
              <Card>
                <MetadataList>
                  <MetadataListItem label="Machine">{host.name}</MetadataListItem>
                  <MetadataListItem label="Version">{`rowrow ${host.version} · oar ${host.oar} · node ${host.node}`}</MetadataListItem>
                  <MetadataListItem label="Address">
                    {host.url + (host.exposed ? " (reachable beyond this machine)" : " (this machine only)")}
                  </MetadataListItem>
                  <MetadataListItem label="Data">
                    <Code>{host.dataDir}</Code>
                  </MetadataListItem>
                  <MetadataListItem label="Running since">
                    {new Date(host.startedAt).toLocaleString()}
                  </MetadataListItem>
                </MetadataList>
              </Card>
            </VStack>
          </VStack>
          <PairDialog link={pairing} onClose={() => setPairing(null)} />
        </LayoutContent>
      }
    />
  );
}

function PairDialog({ link, onClose }: { link: LoginLink | null; onClose: () => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (link === null) return;
    void QRCode.toString(link.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg);
  }, [link]);
  return (
    <Dialog
      isOpen={link !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="info"
      width={420}
    >
      <Layout
        header={
          <DialogHeader
            title="Pair a device"
            subtitle="Scan with the phone's camera, or open the link on the other device."
            onOpenChange={(open) => (open ? undefined : onClose())}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3} hAlign="center">
              {svg !== null && (
                <div
                  style={{ width: 240, height: 240, background: "white", padding: 8, borderRadius: 8 }}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              )}
              <Text type="supporting">{`Works once, for 10 minutes (until ${link === null ? "" : new Date(link.expiresAt).toLocaleTimeString()}).`}</Text>
              <Code>{link?.url ?? ""}</Code>
              {link !== null && new URL(link.url).hostname === "127.0.0.1" && (
                <Banner
                  status="warning"
                  title="This address only works on this machine"
                  description="rowrow listens on 127.0.0.1. To pair a phone, run the server where the phone can reach it (for example behind tailscale serve) and start it with --public-url."
                />
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
