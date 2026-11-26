import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../services/api";
import { apiBase } from "../lib/settings";
import { useAuth } from "../context/AuthContext";

const LINKS = [
  { to: "/", end: true, glyph: "▤", label: "Projects" },
  { to: "/new", glyph: "+", label: "Generator" },
  { to: "/design", glyph: "◇", label: "System design" },
  { to: "/diagrams", glyph: "◫", label: "My diagrams" },
  { to: "/runs", glyph: "↻", label: "History" },
  { to: "/settings", glyph: "⚙", label: "Settings" },
];

function useBackendHealth() {
  const [state, setState] = useState("checking");
  useEffect(() => {
    let alive = true;
    const check = () => api.health().then(() => alive && setState("up")).catch(() => alive && setState("down"));
    check();
    const t = setInterval(check, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return state;
}

export default function Shell({ children }) {
  const health = useBackendHealth();
  const { user, logout } = useAuth();
  const linkClass = ({ isActive }) => `nav-link${isActive ? " active" : ""}`;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>Sierra</span>
          <span className="brand-ver">2.0</span>
        </div>
        <nav className="nav">
          <div className="nav-section">Workspace</div>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
              <span className="nav-glyph">{l.glyph}</span>{l.label}
            </NavLink>
          ))}
        </nav>
        <div className="nav" style={{ marginTop: "auto" }}>
          {user ? (
            <>
              <div className="hint" style={{ padding: "0 12px", overflowWrap: "anywhere" }}>{user.email}</div>
              <button className="nav-link" onClick={logout}><span className="nav-glyph">⎋</span>Sign out</button>
            </>
          ) : <NavLink to="/login" className={linkClass}><span className="nav-glyph">→</span>Sign in</NavLink>}
        </div>
      </aside>
      <main className="main">{children}</main>
      <footer className="statusbar">
        <span><span className={`dot ${health === "up" ? "dot--ok" : health === "down" ? "dot--down" : ""}`} />backend {health === "up" ? "connected" : health === "down" ? "unreachable" : "checking…"}</span>
        <span>{apiBase()}</span>
      </footer>
    </div>
  );
}
