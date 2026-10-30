import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { SessionSummary, WorkspacePreferences } from '../lib/types';
import {
  createTerminalLayoutForPreset,
  hasSavedTerminalLayout,
  loadTerminalLayout,
  saveTerminalLayout,
  terminalIdsInLayout,
  type TerminalWorkspaceLayout,
} from '../lib/terminalLayout';

interface UseTerminalLayoutSyncOptions {
  selected: SessionSummary | null;
  currentIds: string[];
  terminalIdsKey: string;
  layout: TerminalWorkspaceLayout | null;
  layoutSessionId: string | null;
  layoutRef: MutableRefObject<TerminalWorkspaceLayout | null>;
  addInFlightRef: MutableRefObject<boolean>;
  preferences: WorkspacePreferences;
  preferencesLoaded: boolean;
  setLayout: Dispatch<SetStateAction<TerminalWorkspaceLayout | null>>;
  setLayoutSessionId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Keeps the persisted terminal layout in step with the session's terminals.
 * Restores a saved layout when one exists, otherwise builds the preferred preset.
 */
export function useTerminalLayoutSync({
  selected,
  currentIds,
  terminalIdsKey,
  layout,
  layoutSessionId,
  layoutRef,
  addInFlightRef,
  preferences,
  preferencesLoaded,
  setLayout,
  setLayoutSessionId,
}: UseTerminalLayoutSyncOptions): void {
  useEffect(() => {
    if (!preferencesLoaded || !selected) return;
    if (addInFlightRef.current && layoutSessionId === selected.id) return;
    const knownIds = layout
      ? [...terminalIdsInLayout(layout.tree), ...layout.closedTerminalIds]
      : [];
    if (
      layoutSessionId === selected.id &&
      knownIds.length === currentIds.length &&
      currentIds.every((id) => knownIds.includes(id))
    ) {
      return;
    }

    const saved = hasSavedTerminalLayout(selected.id);
    const restored = saved
      ? loadTerminalLayout(selected.id, currentIds)
      : createTerminalLayoutForPreset(
          currentIds,
          preferences.terminalLayout,
          preferences.maximizedTerminalId,
        );
    layoutRef.current = restored;
    setLayout(restored);
    setLayoutSessionId(selected.id);
    saveTerminalLayout(selected.id, restored);
    // currentIds is represented by terminalIdsKey to avoid re-running on every render.
  }, [
    layout,
    layoutSessionId,
    preferences.maximizedTerminalId,
    preferences.terminalLayout,
    preferencesLoaded,
    selected,
    terminalIdsKey,
  ]);
}
