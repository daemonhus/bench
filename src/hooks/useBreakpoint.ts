import { useState, useEffect } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const MOBILE_MQ = '(max-width: 639px)';
const NARROW_MQ = '(max-width: 799px)';
const TABLET_MQ = '(max-width: 1099px)';

function getBreakpoint(): Breakpoint {
  if (window.matchMedia(MOBILE_MQ).matches) return 'mobile';
  if (window.matchMedia(TABLET_MQ).matches) return 'tablet';
  return 'desktop';
}

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_MQ).matches);
  useEffect(() => {
    const mql = window.matchMedia(NARROW_MQ);
    const handler = () => setNarrow(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return narrow;
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(getBreakpoint);

  useEffect(() => {
    const mqlMobile = window.matchMedia(MOBILE_MQ);
    const mqlTablet = window.matchMedia(TABLET_MQ);
    const handler = () => setBp(getBreakpoint());
    mqlMobile.addEventListener('change', handler);
    mqlTablet.addEventListener('change', handler);
    return () => {
      mqlMobile.removeEventListener('change', handler);
      mqlTablet.removeEventListener('change', handler);
    };
  }, []);

  return bp;
}
