import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Wraps the outlet so that each route change gets a workspace-switch animation.
 *
 * The `key` on the wrapper forces React to remount the subtree on every
 * route change, which re-runs the `animate-ws-in` CSS animation. This is a
 * pure visual layer — it does not change routing behavior.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="animate-ws-in min-h-0 flex-1">
      {children}
    </div>
  );
}