"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/misc";
import { apiRequest, errorMessage } from "@/components/client-api";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/v1/session", { method: "POST", body: { password } });
      // Full navigation so every server component re-reads the new cookie.
      window.location.href = "/dashboard";
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label className="label" htmlFor="password">
          Mot de passe admin
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••••"
          disabled={busy}
        />
      </div>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <Button type="submit" variant="primary" disabled={busy || password.length === 0} className="w-full">
        {busy ? "Connexion…" : "Se connecter"}
      </Button>
    </form>
  );
}
