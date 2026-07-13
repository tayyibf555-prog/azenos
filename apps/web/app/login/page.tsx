"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url || !anonKey) return;
    setBusy(true);
    setError(null);
    const supabase = createBrowserClient(url, anonKey);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  const field: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #232a3d",
    background: "#0b0e14",
    color: "#e6e9ef",
    fontSize: 15,
    boxSizing: "border-box",
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ width: 360 }}>
        <h1 style={{ fontSize: 24, marginBottom: 16 }}>Azen OS</h1>
        {!url || !anonKey ? (
          <p style={{ color: "#8b93a7", fontSize: 14 }}>
            Supabase isn&apos;t configured yet (local demo mode). Set
            NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY once the
            hosted project exists — until then the dashboard is open at{" "}
            <a href="/" style={{ color: "#7aa2f7" }}>
              /
            </a>
            .
          </p>
        ) : (
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
            <input
              style={field}
              type="email"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <input
              style={field}
              type="password"
              placeholder="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {error && (
              <p style={{ color: "#c96a72", fontSize: 13, margin: 0 }}>{error}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              style={{
                ...field,
                background: "#7aa2f7",
                color: "#0b0e14",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
