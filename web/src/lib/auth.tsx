/** Session state and the role helpers the router and UI gate on. */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type CurrentUser, type Role } from './api';
import { useTheme } from './theme';

interface AuthValue {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<CurrentUser>;
  register: (input: { name: string; email: string; password: string; organizationName?: string }) => Promise<CurrentUser>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  isAgency: boolean;
  isClientUser: boolean;
  isSuperAdmin: boolean;
  canManage: boolean;
}

const AGENCY_ROLES: Role[] = ['SUPER_ADMIN', 'AGENCY_ADMIN', 'AGENCY_STAFF'];
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const { applyBrand } = useTheme();

  const load = useCallback(async () => {
    try {
      const { user: current } = await api.get<{ user: CurrentUser }>('/auth/me');
      setUser(current);
      // A portal user sees the app in their own brand colours.
      applyBrand(current.client?.brand ?? null);
    } catch {
      setUser(null);
      applyBrand(null);
    } finally {
      setLoading(false);
    }
  }, [applyBrand]);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { user: next } = await api.post<{ user: CurrentUser }>('/auth/login', { email, password });
      // /me carries the nested organization and brand that /login omits.
      await load();
      return next;
    },
    [load],
  );

  const register = useCallback(
    async (input: { name: string; email: string; password: string; organizationName?: string }) => {
      const { user: next } = await api.post<{ user: CurrentUser }>('/auth/register', input);
      await load();
      return next;
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    applyBrand(null);
  }, [applyBrand]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      signIn,
      register,
      signOut,
      refresh: load,
      isAgency: user ? AGENCY_ROLES.includes(user.role) : false,
      isClientUser: user ? user.role === 'CLIENT_ADMIN' || user.role === 'CLIENT_USER' : false,
      isSuperAdmin: user?.role === 'SUPER_ADMIN',
      canManage: user?.role === 'SUPER_ADMIN' || user?.role === 'AGENCY_ADMIN',
    }),
    [user, loading, signIn, register, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
