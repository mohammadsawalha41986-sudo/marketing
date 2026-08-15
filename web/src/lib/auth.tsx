/**
 * Session state.
 *
 * The role helpers this used to export are gone: there is one operator, so
 * "signed in" is the only distinction the UI ever needs to make.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type CurrentUser, type Workspace } from './api';
import { setCurrency } from './format';

interface AuthValue {
  user: CurrentUser | null;
  workspace: Workspace | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<CurrentUser>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ user: CurrentUser; workspace: Workspace }>('/auth/me');
      setUser(data.user);
      setWorkspace(data.workspace);
      setCurrency(data.workspace.currency);
    } catch {
      setUser(null);
      setWorkspace(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { user: next } = await api.post<{ user: CurrentUser }>('/auth/login', { email, password });
      // /me carries the workspace that /login omits.
      await load();
      return next;
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    setWorkspace(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ user, workspace, loading, signIn, signOut, refresh: load }),
    [user, workspace, loading, signIn, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
