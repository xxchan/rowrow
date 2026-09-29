// Find anything in a workspace's checkout (roamgate #227): file names and contents in one
// search, .gitignore honored (files.search, D-021). A result opens a read-only preview at
// its line; "Mention" puts the path in the agent's message, since agents read files by path.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { ArrowLeft, AtSign, Copy, FileText as FileIcon, LoaderCircle, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import type { FileText, SearchResult } from "../../shared/schemas.ts";
import { setDraft, useClient, useDrafts } from "../lib/store.ts";
import { ErrorText } from "./ErrorText.tsx";

export function FilesTab({ workspaceId, agentId }: { workspaceId: string; agentId?: string }) {
  const client = useClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [result, setResult] = useState<{
    query: string;
    data: SearchResult | null;
    error: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<{ path: string; line: number | null } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (client === null || debounced === "") return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.files.search({ workspaceId, query: debounced, kind: "all" });
        if (!cancelled) setResult({ query: debounced, data, error: null });
      } catch (error) {
        if (!cancelled)
          setResult({
            query: debounced,
            data: null,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, debounced]);

  if (preview !== null)
    return (
      <FilePreview
        workspaceId={workspaceId}
        path={preview.path}
        line={preview.line}
        onBack={() => setPreview(null)}
        {...(agentId === undefined ? {} : { agentId })}
      />
    );

  const shown = debounced === "" ? null : result;
  const loading = debounced !== "" && result?.query !== debounced;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search files"
            placeholder="Search file names and contents"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="h-8 pl-8"
          />
          {loading && (
            <LoaderCircle className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {debounced === "" ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            Search this checkout: file names, and lines containing what you type. Ignored files are skipped.
          </p>
        ) : shown?.error !== null && shown?.error !== undefined ? (
          <ErrorText className="px-1">{shown.error}</ErrorText>
        ) : shown?.data === null || shown?.data === undefined ? null : (
          <Results data={shown.data} onOpen={(path, line) => setPreview({ path, line })} />
        )}
      </div>
    </div>
  );
}

function Results({
  data,
  onOpen,
}: {
  data: SearchResult;
  onOpen: (path: string, line: number | null) => void;
}) {
  const byFile = new Map<string, SearchResult["lines"]>();
  for (const hit of data.lines) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
  if (data.names.length === 0 && data.lines.length === 0)
    return (
      <p className="px-4 py-10 text-center text-sm text-muted-foreground">{data.note ?? "No matches."}</p>
    );
  return (
    <div className="flex flex-col gap-4">
      {data.names.length > 0 && (
        <Group label={`Files · ${data.names.length}${data.namesTruncated ? "+" : ""}`}>
          {data.names.map(({ path }) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpen(path, null)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-[12.5px]">
                <span className="text-muted-foreground">{dirname(path)}</span>
                {basename(path)}
              </span>
            </button>
          ))}
        </Group>
      )}
      {byFile.size > 0 && (
        <Group label={`Matches · ${data.lines.length}${data.linesTruncated ? "+" : ""}`}>
          {[...byFile].map(([path, hits]) => (
            <div key={path} className="flex flex-col">
              <button
                type="button"
                onClick={() => onOpen(path, null)}
                className="truncate rounded-md px-2 pt-1.5 pb-0.5 text-left font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
              >
                {path}
              </button>
              {hits.map((hit) => (
                <button
                  key={hit.line}
                  type="button"
                  onClick={() => onOpen(path, hit.line)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/60"
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {hit.line}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[12px]">
                    {highlight(hit.text, data.query)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </Group>
      )}
      {data.note !== null && <p className="px-2 text-xs text-muted-foreground">{data.note}</p>}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** Marks the query in a line the way the server matched it: case-insensitive unless it has an uppercase letter. */
function highlight(text: string, query: string): ReactNode {
  const smart = query === query.toLowerCase();
  const at = (smart ? text.toLowerCase() : text).indexOf(smart ? query.toLowerCase() : query);
  if (at < 0) return text.trim();
  return (
    <>
      {text.slice(0, at).trimStart()}
      <mark className="rounded-sm bg-warning/30 text-foreground">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

const dirname = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const LINE = 20; // px, the preview's line height (leading-5)

/** A read-only view of one file, scrolled to `line` (highlighted) when given. */
export function FilePreview({
  workspaceId,
  path,
  line,
  onBack,
  agentId,
}: {
  workspaceId: string;
  path: string;
  line: number | null;
  onBack: () => void;
  agentId?: string;
}) {
  const client = useClient();
  const [file, setFile] = useState<{ path: string; data: FileText | null; error: string | null } | null>(
    null,
  );
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  const [view, setView] = useState<"rendered" | "source">(markdown && line === null ? "rendered" : "source");
  const scroller = useRef<HTMLDivElement>(null);
  const draft = useDrafts((s) => (agentId === undefined ? "" : (s.byAgent[agentId] ?? "")));

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await client.files.read({ workspaceId, path });
        if (!cancelled) setFile({ path, data, error: null });
      } catch (error) {
        if (!cancelled)
          setFile({ path, data: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, path]);

  const text = file?.path === path ? file.data?.text : undefined;
  useLayoutEffect(() => {
    if (text === undefined || line === null || scroller.current === null) return;
    scroller.current.scrollTop = Math.max(0, (line - 1) * LINE - scroller.current.clientHeight / 3);
  }, [text, line]);

  const lines = text === undefined ? 0 : text.split("\n").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-8" aria-label="Back to results" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={path}>
          {path}
        </span>
        {markdown && (
          <Tabs value={view} onValueChange={(value) => setView(value as "rendered" | "source")}>
            <TabsList className="h-7">
              <TabsTrigger value="rendered" className="px-2 text-[11px]">
                Preview
              </TabsTrigger>
              <TabsTrigger value="source" className="px-2 text-[11px]">
                Source
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Copy the path"
          onClick={() => void navigator.clipboard.writeText(path).then(() => toast.success("Path copied"))}
        >
          <Copy />
        </Button>
        {agentId !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={() => {
              const mention = `\`${path}\``;
              setDraft(agentId, draft.trim() === "" ? `${mention} ` : `${draft.trimEnd()} ${mention} `);
              toast.success("Added to your message");
            }}
          >
            <AtSign /> Mention
          </Button>
        )}
      </div>
      {file === null || file.path !== path ? (
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Loading {path}
        </div>
      ) : file.error !== null || file.data === null ? (
        <ErrorText className="px-4 py-3">{file.error ?? "Couldn't read it."}</ErrorText>
      ) : view === "rendered" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Streamdown
            className="text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold"
            plugins={{ code, cjk }}
            shikiTheme={["github-light", "tokyo-night"]}
            linkSafety={{ enabled: false }}
            mode="static"
          >
            {file.data.text}
          </Streamdown>
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-code">
          <div className="relative flex min-w-max font-mono text-[12px] leading-5">
            {line !== null && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bg-primary/15"
                style={{ top: 8 + (line - 1) * LINE, height: LINE }}
              />
            )}
            <pre className="sticky left-0 z-10 border-r bg-code px-3 py-2 text-right text-muted-foreground/60 select-none">
              {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
            </pre>
            <pre className={cn("px-3 py-2", file.data.truncated && "pb-0")}>{file.data.text}</pre>
          </div>
          {file.data.truncated && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {`Stopped at 1 MiB of ${Math.round(file.data.size / 1024)} KB.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
