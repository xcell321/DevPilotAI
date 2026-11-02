import { useRef, useState } from 'react';

/**
 * Returns a key that changes whenever `value` changes, so a parent component
 * can re-trigger a CSS animation (e.g. a scale pop) on numeric counters.
 *
 * This is purely visual — it does not animate the number itself, only signals
 * that the displayed value changed so a CSS keyframe can run.
 */
export function useCountupKey(value: unknown): string {
  const [key, setKey] = useState(String(value));
  const ref = useRef(value);
  if (ref.current !== value) {
    ref.current = value;
    setKey(`${String(value)}-${Math.random().toString(36).slice(2, 8)}`);
  }
  return key;
}