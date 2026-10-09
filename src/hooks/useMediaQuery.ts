import { useSyncExternalStore } from 'react';

/** Live `window.matchMedia` match (false where matchMedia is unavailable, e.g. tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined;
      mq?.addEventListener('change', notify);
      return () => mq?.removeEventListener('change', notify);
    },
    () => (typeof window !== 'undefined' && window.matchMedia?.(query).matches) === true,
    () => false,
  );
}
