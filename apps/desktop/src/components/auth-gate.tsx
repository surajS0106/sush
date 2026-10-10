import type { ReactNode } from "react";

import { LoginScreen } from "@/components/login-screen";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth";

/** Renders the app only for a signed-in user; otherwise the login screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div data-tauri-drag-region className="flex h-svh items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  return session ? children : <LoginScreen />;
}
