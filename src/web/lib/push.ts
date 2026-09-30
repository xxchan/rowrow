// Web Push on this device: a service worker shows notifications even when rowrow isn't
// open (on iPhone: after "Add to Home Screen"). Needs a secure origin: HTTPS, or localhost.
import type { Client } from "./connection.ts";
import { report } from "./telemetry.ts";

export type PushSupport = "ok" | "insecure" | "unsupported" | "desktop";

/** Inside the rowrow app for Mac, which says so in its user agent (docs/desktop.md). */
export function inDesktopApp(): boolean {
  return navigator.userAgent.includes(" rowrow-desktop/");
}

export function pushSupport(): PushSupport {
  // The Mac app has no push service (Electron doesn't); it shows notifications itself (notify.watch).
  if (inDesktopApp()) return "desktop";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "unsupported";
  return "ok";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport() !== "ok") return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (error) {
    report("warn", "sw.register_failed", error);
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(client: Client, publicKey: string): Promise<void> {
  const registration = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      permission === "denied"
        ? "notifications are blocked for this site in the browser's settings"
        : "permission was not granted",
    );
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  const json = subscription.toJSON();
  const { endpoint, keys } = json;
  if (endpoint === undefined || keys?.["p256dh"] === undefined || keys["auth"] === undefined)
    throw new Error("the browser returned an incomplete subscription");
  await client.notify.subscribe({ endpoint, keys: { p256dh: keys["p256dh"], auth: keys["auth"] } });
}

export async function disablePush(client: Client): Promise<void> {
  const subscription = await currentSubscription();
  await subscription?.unsubscribe();
  await client.notify.unsubscribe();
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
