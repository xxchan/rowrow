// What the agent runs beside the conversation (oar's task events, the summary's `tasks`):
// background commands, subagents, tool calls moved off the turn. They can outlive the turn, so
// an agent can look finished while work goes on; this says so, in the agent's header.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TaskView } from "@botiverse/oar/observe";
import { Bot, CircleDashed, LoaderCircle, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";
import { ago } from "../lib/format.ts";

const KIND: Record<TaskView["taskType"], { label: string; icon: LucideIcon }> = {
  shell: { label: "Command", icon: SquareTerminal },
  agent: { label: "Subagent", icon: Bot },
  tool: { label: "Tool call", icon: Wrench },
  other: { label: "Task", icon: CircleDashed },
};

export function BackgroundTasks({ tasks, now }: { tasks: readonly TaskView[]; now: number }) {
  if (tasks.length === 0) return null;
  const label = `${tasks.length} in background`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={label}>
          <LoaderCircle className="animate-spin" />
          <span className="hidden md:inline">{label}</span>
          <span className="tabular-nums md:hidden">{tasks.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          Running beside the conversation. They stop when the agent does.
        </p>
        <ul className="max-h-80 divide-y overflow-y-auto">
          {tasks.map((task) => {
            const kind = KIND[task.taskType];
            const Icon = kind.icon;
            const facts = [
              task.nativeType === undefined ? kind.label : `${kind.label} (${task.nativeType})`,
              task.status === "running" ? null : task.status,
              task.startedAt === undefined
                ? null
                : ago(task.startedAt, now) === "now"
                  ? "just started"
                  : `for ${ago(task.startedAt, now)}`,
            ].filter((fact) => fact !== null);
            return (
              <li key={task.taskId} className="flex items-start gap-2.5 px-3 py-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm break-words">{task.description ?? kind.label}</p>
                  <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
