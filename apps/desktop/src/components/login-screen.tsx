import { useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth";

type Mode = "sign-in" | "sign-up";

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const signingUp = mode === "sign-up";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { error } = signingUp
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (error) setError(error.message ?? error.statusText ?? "Something went wrong");
    } catch {
      setError("Can't reach the auth server. Is it running?");
    } finally {
      setPending(false);
    }
  };

  const switchMode = () => {
    setMode(signingUp ? "sign-in" : "sign-up");
    setError(null);
  };

  return (
    <div data-tauri-drag-region className="flex h-svh items-center justify-center bg-background p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/sush-mark.png" alt="Sush" className="size-12 rounded-xl" />
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold">{signingUp ? "Create your account" : "Sign in to Sush"}</h1>
            <p className="text-sm text-muted-foreground">
              {signingUp ? "Enter your details to get started." : "Welcome back. Enter your email and password."}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {signingUp && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
            />
            {signingUp && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending} className="w-full">
            {pending && <Spinner />}
            {signingUp ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {signingUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button type="button" onClick={switchMode} className="font-medium text-foreground underline-offset-4 hover:underline">
            {signingUp ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}
