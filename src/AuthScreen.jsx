import React, { useState } from "react";
import { supabase } from "./supabaseClient";

export default function AuthScreen({ onAuth }) {
  const [mode, setMode]       = useState("signin"); // "signin" | "signup" | "forgot"
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [message, setMessage] = useState("");

  const switchMode = (next) => { setMode(next); setError(""); setMessage(""); };

  const handleSubmit = async () => {
    setError("");
    setMessage("");

    // ── Forgot password ────────────────────────────────────────────────────
    if (mode === "forgot") {
      if (!email.trim()) { setError("Enter your email address."); return; }
      setLoading(true);
      try {
        const { error: err } = await supabase.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: window.location.origin }
        );
        if (err) throw err;
        setMessage("Password reset link sent — check your inbox and spam folder.");
      } catch (err) {
        setError(err.message || "Something went wrong.");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    setLoading(true);

    try {
      // ── Sign up ──────────────────────────────────────────────────────────
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            // Always redirect back to wherever the app is actually running.
            // Without this Supabase defaults to the dashboard Site URL (localhost).
            emailRedirectTo: window.location.origin,
          },
        });
        if (err) throw err;

        if (data.session) {
          // Email confirmation is disabled in Supabase — logged in immediately.
          onAuth(data.user);
        } else {
          // Confirmation email sent. Note: Supabase returns the same response for
          // already-registered emails (by design, to prevent email enumeration),
          // so we show a message that covers both cases.
          setMessage(
            "If this is a new account, a confirmation link is on its way. " +
            "Check your inbox and spam folder, then come back to sign in. " +
            "If you already have an account, just sign in below."
          );
          setMode("signin");
          setPassword("");
        }

      // ── Sign in ──────────────────────────────────────────────────────────
      } else {
        const { data, error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) throw err;
        onAuth(data.user);
      }
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("Invalid login credentials")) {
        setError("Email or password is incorrect. Use \"Forgot your password?\" if needed.");
      } else if (msg.includes("Email not confirmed")) {
        setError("Please confirm your email first — check your inbox for the confirmation link.");
      } else {
        setError(msg || "Something went wrong.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => { if (e.key === "Enter") handleSubmit(); };

  const title = mode === "forgot" ? "Reset your password"
              : mode === "signup" ? "Create an account"
              : "Sign in";

  const submitLabel = loading
    ? (mode === "forgot" ? "Sending link..." : mode === "signup" ? "Creating account..." : "Signing in...")
    : (mode === "forgot" ? "Send reset link"  : mode === "signup" ? "Create account"    : "Sign in");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm">

        <div className="mb-8 text-center">
          <div className="mb-3 text-5xl">🏕️</div>
          <h1 className="text-3xl font-bold text-slate-900">CampReady</h1>
          <p className="mt-1 text-sm text-slate-500">RV Camping Planner</p>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-5 text-xl font-bold text-slate-900">{title}</h2>

          {/* Sign in / Create account toggle — hidden in forgot mode */}
          {mode !== "forgot" && (
            <div className="mb-5 flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
              <button type="button" onClick={() => switchMode("signin")}
                className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${mode === "signin" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
                Sign in
              </button>
              <button type="button" onClick={() => switchMode("signup")}
                className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${mode === "signup" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
                Create account
              </button>
            </div>
          )}

          {error   && <div className="mb-4 rounded-2xl border border-red-200   bg-red-50   px-4 py-3 text-sm text-red-700"  >{error  }</div>}
          {message && <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{message}</div>}

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Email</label>
              <input type="email" autoComplete="email"
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
                placeholder="you@example.com" value={email}
                onChange={(e) => setEmail(e.target.value)} onKeyDown={handleKeyDown} />
            </div>
            {mode !== "forgot" && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Password</label>
                <input type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
                  placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)} onKeyDown={handleKeyDown} />
              </div>
            )}
          </div>

          {/* Forgot password link — only on sign-in screen */}
          {mode === "signin" && (
            <button type="button" onClick={() => switchMode("forgot")}
              className="mt-3 text-xs font-semibold text-slate-400 hover:text-slate-600">
              Forgot your password?
            </button>
          )}

          <button type="button" onClick={handleSubmit} disabled={loading}
            className="mt-5 w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-60">
            {submitLabel}
          </button>

          {mode === "forgot" && (
            <button type="button" onClick={() => switchMode("signin")}
              className="mt-3 block w-full text-center text-sm font-semibold text-slate-400 hover:text-slate-600">
              ← Back to sign in
            </button>
          )}

          <p className="mt-4 text-center text-xs text-slate-400">
            Your data is stored securely and syncs across all your devices.
          </p>
        </div>
      </div>
    </div>
  );
}
