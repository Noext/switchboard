import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { uiAuthState } from "@/components/server/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion — Switchboard" };

export default async function LoginPage() {
  if (await uiAuthState()) redirect("/dashboard");

  return (
    <div className="w-full max-w-[380px]">
      <div className="mb-5 flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-[15px] font-bold text-[hsl(var(--accent-ink))]">
          S
        </div>
        <div>
          <h1 className="text-[17px] font-semibold leading-tight">Switchboard</h1>
          <p className="text-[11.5px] text-muted">Console d'administration</p>
        </div>
      </div>
      <div className="card">
        <div className="card-body">
          <LoginForm />
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted">
        Mot de passe défini par <span className="mono">SWITCHBOARD_ADMIN_PASSWORD</span>.
      </p>
    </div>
  );
}
