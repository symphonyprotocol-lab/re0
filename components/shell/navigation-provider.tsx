'use client';

import { createContext, startTransition as startReactTransition, useCallback, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import './workspace-motion.css';

const NavigationContext = createContext<(action: () => void) => void>(startReactTransition);
const LoadingContext = createContext<() => () => void>(() => () => {});

/** React owns the pending lifetime, including redirects, cancellation, and errors. */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [pending, startNavigation] = useTransition();
  const [loading, setLoading] = useState(0);
  const registerLoading = useCallback(() => {
    setLoading((count) => count + 1);
    return () => setLoading((count) => count - 1);
  }, []);
  return (
    <NavigationContext.Provider value={startNavigation}>
      <LoadingContext.Provider value={registerLoading}>
        {children}
        <div className="route-navigation-feedback" data-pending={pending || loading > 0}>
          <div className="route-navigation-progress" aria-hidden="true"><i /></div>
        </div>
      </LoadingContext.Provider>
    </NavigationContext.Provider>
  );
}

/** Includes streaming fallbacks after the URL has already committed. */
export function useRouteLoading(): void {
  const register = useContext(LoadingContext);
  useEffect(register, [register]);
}

/** Track imperative navigation as well as links; a data refresh stays in place. */
export function useNavigationRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  const navigate = useContext(NavigationContext);
  return useMemo(() => ({
    ...router,
    push: (...args: Parameters<typeof router.push>) => navigate(() => router.push(...args)),
    replace: (...args: Parameters<typeof router.replace>) => navigate(() => router.replace(...args)),
    back: () => navigate(() => router.back()),
    forward: () => navigate(() => router.forward()),
  }), [router, navigate]);
}
