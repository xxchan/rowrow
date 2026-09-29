import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** A calm placeholder for an empty list or a missing page. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-16 text-center", className)}>
      {icon !== undefined && (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="max-w-sm space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
