import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../services/api";
import { clearToken, getToken, setToken } from "../lib/session";

const AuthContext = createContext(null);
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => !!getToken()); // only wait for /me when a token exists

  useEffect(() => {
    if (!getToken()) return undefined;
    let alive = true;
    api.me()
      .then((d) => alive && setUser(d.user))
      .catch((e) => { if (e.status === 401) clearToken(); }) // network errors keep the token for a retry
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const finish = useCallback((d) => { setToken(d.token); setUser(d.user); return d.user; }, []);
  const value = useMemo(() => ({
    user, loading,
    login: async (email, password) => finish(await api.login(email, password)),
    register: async (email, password) => finish(await api.register(email, password)),
    logout: () => { clearToken(); setUser(null); },
  }), [user, loading, finish]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
