// Paths the agent mentions as links that open the file in the inspector (D-054): inline code
// in its replies, the file in a tool call's row, and paths in a search's or a command's output.
// A click shows the file in the Files view's temporary tab, as a single click in the tree does,
// at the line the path names. Only inside <FileLinks> (an agent's transcript, which knows its
// workspace): elsewhere, and for paths that name no file of the checkout, text stays text.
import { cn } from "@/lib/utils";
import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "streamdown";
import { fileTarget, findFileRefs, type CheckoutFiles, type FileTarget } from "../../shared/file-refs.ts";
import { openFile, useCheckoutFiles } from "../lib/file-links.ts";

interface Links {
  readonly workspaceId: string;
  readonly files: CheckoutFiles;
}

const LinksContext = createContext<Links | null>(null);

/** Links the paths that name files of the workspace's checkout, in everything inside it. */
export function FileLinks({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const files = useCheckoutFiles(workspaceId);
  const links = useMemo(() => (files === null ? null : { workspaceId, files }), [workspaceId, files]);
  return <LinksContext.Provider value={links}>{children}</LinksContext.Provider>;
}

/** The checkout's files where paths link (null: nowhere, here). */
export function useFileLinks(): Links | null {
  return useContext(LinksContext);
}

/** A path that opens its file in the inspector. */
export function FileLink({
  target,
  className,
  children,
}: {
  target: FileTarget;
  className?: string;
  children: ReactNode;
}) {
  const links = useContext(LinksContext);
  if (links === null) return children;
  return (
    <button
      type="button"
      title={`Open ${target.path}${target.line === null ? "" : ` at line ${target.line}`} in Files`}
      onClick={() => openFile(links.workspaceId, target.path, target.line)}
      className={cn(
        "cursor-pointer text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px] hover:text-primary hover:decoration-solid hover:decoration-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Streamdown's inline code (its own look), a link when it names a file of the checkout. */
export function InlineCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  const links = useContext(LinksContext);
  const code = (
    <code
      className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
      data-streamdown="inline-code"
      {...props}
    >
      {children}
    </code>
  );
  const target = links === null || typeof children !== "string" ? null : fileTarget(children, links.files);
  return target === null ? code : <FileLink target={target}>{code}</FileLink>;
}

/** Text with the files of the checkout it mentions as links (a tool's output). */
export function LinkedText({ text }: { text: string }) {
  const links = useContext(LinksContext);
  const found = useMemo(() => (links === null ? [] : findFileRefs(text, links.files)), [text, links]);
  if (found.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const { start, end, target } of found) {
    out.push(text.slice(at, start));
    out.push(
      <FileLink key={start} target={target}>
        {text.slice(start, end)}
      </FileLink>,
    );
    at = end;
  }
  out.push(text.slice(at));
  return out;
}
