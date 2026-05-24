import React, { useState } from "react";
import { supabase } from "./supabaseClient";

export default function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const handleSubmit = async () => {
    setError("");
    setMessage("");
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Always redirect back to wherever the app is actually running.
            // Without this Supabase falls back to the Site URL set in the
            // dashboard, which defaults to http://localhost:3000 on new projects.
            emailRedirectTo: window.location.origin,
          },
        });
        if (err) throw err;
        if (data.user && !data.session) {
          // Email confirmation required
          setMessage("Check your email for a confirmation link, then sign in.");
        } else if (data.session) {
          onAuth(data.user);
        }
      } else {
        const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        onAuth(data.user);
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSubmit();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm">
        {/* Logo / header */}
        <div className="mb-8 text-center">
          <div className="mb-3 text-5xl">🏕️</div>
          <h1 className="text-3xl font-bold text-slate-900">CampReady</h1>
          <p className="mt-1 text-sm text-slate-500">RV Camping Planner</p>
        </div>

        {/* Card */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-5 text-xl font-bold text-slate-900">
            {mode === "signin" ? "Sign in to your account" : "Create an account"}
          </h2>

          {/* Mode toggle */}
          <div className="mb-5 flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => { setMode("signin"); setError(""); setMessage(""); }}
              className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${
                mode === "signin" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode("signup"); setError(""); setMessage(""); }}
              className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${
                mode === "signup" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
              }`}
            >
              Create account
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Success message */}
          {message && (
            <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {message}
            </div>
          )}

          {/* Fields */}
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Email</label>
              <input
                type="email"
                autoComplete="email"
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500">Password</label>
              <input
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
                placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="mt-5 w-full rounded-2xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-60"
          >
            {loading
              ? mode === "signin" ? "Signing in..." : "Creating account..."
              : mode === "signin" ? "Sign in" : "Create account"}
          </button>

          {/* Note */}
          <p className="mt-4 text-center text-xs text-slate-400">
            Your data is stored securely and syncs across all your devices.
          </p>
        </div>
      </div>
    </div>
  );
}
