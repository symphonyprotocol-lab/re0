'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/icons';

const ToastContext = createContext<(message: string) => void>(() => undefined);

/** One short confirmation at a time, bottom centre, as in the prototype. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const show = useCallback((message: string) => {
    const id = Date.now();
    setToast({ id, message });
    setTimeout(() => setToast((current) => (current?.id === id ? null : current)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
        {toast && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-ink px-4 py-3 text-[12px] font-medium text-white shadow-lg">
            <Icon name="check" className="size-4 text-[#8fc1ff]" />
            {toast.message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string) => void {
  return useContext(ToastContext);
}
