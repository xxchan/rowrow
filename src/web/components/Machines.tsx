// The machines rowrow for Mac knows, inside one machine's page (D-059): the sidebar's first row
// switches between them, and Settings lists them. Each machine has its own agents, workspaces
// and settings; the app keeps a window onto each. In a browser there's one machine, this one, and
// the row is what it always was.
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, MoreHorizontal, Plus, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { AppMachine, AppMachines } from "../../shared/app-bridge.ts";
import { askApp, machineTone, machineWords, useMachines, type MachinesBridge } from "../lib/mac-app.ts";
import { RouterLink } from "../lib/router.ts";
import { StatusDot } from "./StatusDot.tsx";

/**
 * The sidebar's first row: rowrow's mark, its name and this machine's. In rowrow for Mac it opens
 * a menu of the app's machines, with how many agents need you on the others; elsewhere it's a
 * link to all agents.
 */
export function MachineSwitcher({
  appName,
  hostName,
  mark,
}: {
  appName: string;
  hostName: string;
  mark: ReactNode;
}) {
  const machines = useMachines();
  if (machines === null)
    return (
      <RouterLink href="/" className="flex min-w-0 items-center gap-2.5 rounded-md">
        <Identity mark={mark} appName={appName} machine={hostName} />
      </RouterLink>
    );
  const { bridge, list } = machines;
  const current = list?.machines.find((m) => m.id === list.current) ?? null;
  const name = current?.name ?? hostName;
  const elsewhere = (list?.machines ?? [])
    .filter((m) => m.id !== list?.current)
    .reduce((sum, m) => sum + (m.needsYou ?? 0), 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Machine: ${name}${elsewhere > 0 ? `, ${elsewhere} need${elsewhere === 1 ? "s" : ""} you on other machines` : ""}`}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
        >
          <Identity mark={mark} appName={appName} machine={name} />
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {elsewhere > 0 && (
              <span className="flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white">
                {elsewhere}
              </span>
            )}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Machines</DropdownMenuLabel>
        {(list?.machines ?? []).map((machine) => {
          const here = machine.id === list?.current;
          return (
            <DropdownMenuItem
              key={machine.id}
              role="menuitemradio"
              aria-checked={here}
              onSelect={() => {
                if (!here) askApp(`Opening ${machine.name}`, () => bridge.openMachine(machine.id));
              }}
            >
              <span aria-hidden>
                <StatusDot tone={machineTone(machine)} label={machine.statusText} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{machine.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{machineWords(machine)}</span>
              </span>
              <Check className={cn("size-4 text-foreground", !here && "invisible")} />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => askApp("Opening rowrow", () => bridge.showMachines("add"))}>
          <Plus /> Add a machine…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => askApp("Opening rowrow", () => bridge.showMachines("manage"))}>
          <Server /> Manage machines…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Identity({ mark, appName, machine }: { mark: ReactNode; appName: string; machine: string }) {
  return (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        {mark}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm leading-4 font-semibold text-foreground">{appName}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{machine}</span>
      </span>
    </>
  );
}

/** Settings → Machines: each machine's state, opening it, removing it, and its waiting upgrade. */
export function MachineList({ bridge, list }: { bridge: MachinesBridge; list: AppMachines | null }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {(list?.machines ?? []).map((machine) => (
          <MachineRow
            key={machine.id}
            bridge={bridge}
            machine={machine}
            here={machine.id === list?.current}
          />
        ))}
      </ul>
      <div>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 text-muted-foreground"
          onClick={() => askApp("Opening rowrow", () => bridge.showMachines("manage"))}
        >
          <Server /> Manage machines…
        </Button>
      </div>
    </div>
  );
}

function MachineRow({
  bridge,
  machine,
  here,
}: {
  bridge: MachinesBridge;
  machine: AppMachine;
  here: boolean;
}) {
  const { upgrade } = machine;
  return (
    <li aria-label={machine.name} className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <StatusDot tone={machineTone(machine)} label={machine.statusText} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {machine.name}
            {here && <span className="font-normal text-muted-foreground"> (this window)</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[
              machineWords(machine),
              machine.kind === "ssh" ? "over SSH" : machine.kind === "url" ? "signed in by link" : null,
              machine.version === null ? null : `rowrow ${machine.version}`,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </div>
        </div>
        {!here && (
          <Button
            size="sm"
            variant="outline"
            disabled={machine.status === "setting-up"}
            onClick={() => askApp(`Opening ${machine.name}`, () => bridge.openMachine(machine.id))}
          >
            Open
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More for ${machine.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => askApp(`Removing ${machine.name}`, () => bridge.removeMachine(machine.id))}
            >
              Remove from this Mac…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {upgrade !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {upgrade.state === "waiting"
              ? `rowrow ${upgrade.version} is ready for ${machine.name}. It restarts into it when ${upgrade.waitingFor === 1 ? "an agent finishes" : `${upgrade.waitingFor} agents finish`}.`
              : upgrade.state === "installing"
                ? `Updating ${machine.name} to rowrow ${upgrade.version}…`
                : `Updating ${machine.name} to rowrow ${upgrade.version} failed: ${upgrade.error ?? "unknown error"}`}
          </span>
          {upgrade.state !== "installing" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => askApp(`Updating ${machine.name}`, () => bridge.upgradeMachine(machine.id))}
            >
              {upgrade.state === "waiting" ? "Restart now" : "Try again"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
