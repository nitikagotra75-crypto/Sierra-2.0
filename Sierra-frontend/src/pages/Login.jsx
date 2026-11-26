import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  const { state } = useLocation();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const to = state?.from || "/diagrams";
  if (user) return <Navigate to={to} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await (mode === "login" ? login(email, password) : register(email, password));
      nav(to, { replace: true });
    } catch (err) {
      setError(err.status === 503 ? "The server has no SIERRA_AUTH_SECRET configured, so accounts are disabled." : err.message);
    }
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <form className="panel panel-pad auth-card form" onSubmit={submit} aria-label={mode === "login" ? "Sign in" : "Create account"}>
        <div className="section-title" style={{ margin: 0 }}>{mode === "login" ? "Sign in" : "Create account"}</div>
        <div className="hint">An account lets you keep architecture diagrams on the server and open them from any device.</div>
        <div><label className="field-label" htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="field-label" htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />{mode === "register" && <div className="hint">At least 8 characters.</div>}</div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <button type="button" className="btn" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>{mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}</button>
      </form>
    </div>
  );
}
