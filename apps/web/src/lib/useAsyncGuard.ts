import { useCallback, useRef, useState } from 'react';

export function useAsyncGuard() {
  const inFlightRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);

  const guard = useCallback(() => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setIsLoading(true);
    return true;
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    setIsLoading(false);
  }, []);

  return { isLoading, guard, reset };
}

export default useAsyncGuard;
