import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** An inline error message. */
export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-destructive", className)}>{children}</p>;
}
