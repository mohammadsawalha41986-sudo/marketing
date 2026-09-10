/**
 * The project currently being worked on.
 *
 * Every screen in here is about one project at a time — its campaigns, its
 * posts, its assets, its integrations. Before this, each page carried its own
 * picker, so choosing a project on Content and then opening Analytics meant
 * choosing it again, and the two could silently disagree about whose numbers
 * were on screen. The choice belongs to the session, not to the page.
 *
 * Two mechanisms already existed and are both preserved rather than replaced:
 * pages like Campaigns and Content filter from the `?client=` search param
 * (which is what makes a filtered view linkable), while Media, Integrations and
 * Analytics held the id in local state. This provider is the single source, and
 * keeps `?client=` in step so a link still carries the project with it.
 *
 * The API, the database and this module's own symbols still say client and
 * restaurant. Renaming them would be a migration and a wide refactor for a
 * wording change, so the vocabulary meets the product at the translation layer
 * and at this type. Only what an operator reads has changed.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, qs, type Paginated } from './api';
import { useAuth } from './auth';

export interface RestaurantOption {
  id: string;
  name: string;
  businessName: string;
  /**
   * What kind of business this project is — restaurant, clinic, retailer.
   * A property of the project, never the global noun for it: the product
   * manages marketing for companies of any kind, and the entity is a Project.
   */
  businessType: string | null;
  logoUrl: string | null;
  /** Where the business operates, when it has told us. Shown beside its name. */
  location: string | null;
  status: string;
}

interface RestaurantValue {
  /** Every project the signed-in operator can act on. */
  restaurants: RestaurantOption[];
  loading: boolean;
  /** Empty string means "all projects", which several pages support. */
  currentId: string;
  current: RestaurantOption | null;
  setCurrentId: (id: string) => void;
}

const STORAGE_KEY = 'mos.restaurant';
const RestaurantContext = createContext<RestaurantValue | null>(null);

export function RestaurantProvider({ children }: { children: ReactNode }) {
  const { user, isAgency, isClientUser } = useAuth();
  const [restaurants, setRestaurants] = useState<RestaurantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useSearchParams();

  // A deep link wins over whatever was chosen last: someone sent that URL
  // because of the project in it.
  const fromUrl = params.get('client') ?? '';
  const [stored, setStored] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const currentId = isClientUser ? user?.clientId ?? '' : fromUrl || stored;

  useEffect(() => {
    if (!isAgency) {
      setRestaurants([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<Paginated<RestaurantOption>>(`/clients${qs({ pageSize: 100 })}`)
      .then((data) => {
        if (!cancelled) setRestaurants(data.items);
      })
      .catch(() => {
        // A failed list leaves the picker empty rather than blocking the app.
        if (!cancelled) setRestaurants([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAgency]);

  // A project that was deleted, or that belongs to another organization,
  // must not linger as the active selection.
  useEffect(() => {
    if (!isAgency || loading || !stored || restaurants.length === 0) return;
    if (!restaurants.some((row) => row.id === stored)) {
      localStorage.removeItem(STORAGE_KEY);
      setStored('');
    }
  }, [isAgency, loading, stored, restaurants]);

  const setCurrentId = useCallback(
    (id: string) => {
      setStored(id);
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);

      // Only rewrite the URL where it already carried the filter. Adding
      // ?client= to a page that ignores it would just be noise in the address
      // bar — and a back-button entry for a choice that did nothing.
      setParams(
        (previous) => {
          if (!previous.has('client')) return previous;
          const next = new URLSearchParams(previous);
          if (id) next.set('client', id);
          else next.delete('client');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const current = useMemo(
    () => restaurants.find((row) => row.id === currentId) ?? null,
    [restaurants, currentId],
  );

  const value = useMemo<RestaurantValue>(
    () => ({ restaurants, loading, currentId, current, setCurrentId }),
    [restaurants, loading, currentId, current, setCurrentId],
  );

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>;
}

export function useRestaurant(): RestaurantValue {
  const context = useContext(RestaurantContext);
  if (!context) throw new Error('useRestaurant must be used inside <RestaurantProvider>');
  return context;
}
