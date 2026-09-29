import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { report } from "../lib/telemetry.ts";

interface State {
  readonly error: Error | null;
}

/** A render error is reported to the server log (client.render_error) and shown, never a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    report("error", "render_error", error, { componentStack: info.componentStack?.slice(0, 2000) });
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <EmptyState
        title="Something broke on this page"
        description={`${this.state.error.message}. It was reported to the server log (rowrow errors).`}
        actions={<Button label="Reload" variant="primary" onClick={() => location.reload()} />}
      />
    );
  }
}
