import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCcwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  /** Shown above the error, e.g. what couldn't be shown. */
  title: string;
  /** A change (the open session, the page) clears the error, to try again on the new content. */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: unknown;
}

/**
 * Catches an error while drawing its children and shows it in their place,
 * so one broken view doesn't blank the whole window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <TriangleAlertIcon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{this.props.title}</p>
        <p className="max-w-md text-xs break-words text-muted-foreground">{error.message || String(error)}</p>
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => this.setState({ error: null })}>
          <RefreshCcwIcon className="size-3.5" /> Try again
        </Button>
      </div>
    );
  }
}
