import { describe, expect, it } from 'vitest';
import {
  hasSavedTerminalLayout,
  createTerminalLayoutForPreset,
  loadTerminalLayout,
  reconcileTerminalLayout,
  removeTerminal,
  resizeTerminalSplit,
  saveTerminalLayout,
  splitTerminal,
  terminalIdsInLayout,
  type TerminalLayoutStorage,
  type TerminalWorkspaceLayout,
} from '../../apps/web/src/lib/terminalLayout';

function createStorage(): TerminalLayoutStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('terminal split layout', () => {
  it('creates nested horizontal and vertical splits and collapses closed branches', () => {
    const first = splitTerminal(null, null, 'terminal-a', 'right');
    const second = splitTerminal(first, 'terminal-a', 'terminal-b', 'right');
    const nested = splitTerminal(second, 'terminal-b', 'terminal-c', 'down');

    expect(terminalIdsInLayout(nested)).toEqual([
      'terminal-a',
      'terminal-b',
      'terminal-c',
    ]);
    expect(nested).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      second: {
        type: 'split',
        direction: 'vertical',
      },
    });

    const resized = resizeTerminalSplit(nested, [false], 0.7);
    expect(resized?.type).toBe('split');
    if (resized?.type !== 'split') throw new Error('Expected the resized root split.');
    expect(resized.second).toMatchObject({ type: 'split', ratio: 0.7 });
    expect(removeTerminal(resized, 'terminal-b')).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      second: { type: 'terminal', terminalId: 'terminal-c' },
    });
  });

  it('clamps divider sizes to usable proportions', () => {
    const tree = splitTerminal(null, null, 'terminal-a', 'right');
    const split = splitTerminal(tree, 'terminal-a', 'terminal-b', 'right');

    expect(resizeTerminalSplit(split, [], 0)).toMatchObject({ type: 'split', ratio: 0.1 });
    expect(resizeTerminalSplit(split, [], 1)).toMatchObject({ type: 'split', ratio: 0.9 });
  });

  it('creates a balanced 2x2 grid and adapts balanced layouts to additional terminals', () => {
    const grid = createTerminalLayoutForPreset(
      ['terminal-a', 'terminal-b', 'terminal-c', 'terminal-d'],
      'grid',
    );
    expect(grid.tree).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'split', direction: 'vertical', ratio: 0.5 },
      second: { type: 'split', direction: 'vertical', ratio: 0.5 },
    });

    const fiveTerminals = createTerminalLayoutForPreset(
      ['terminal-a', 'terminal-b', 'terminal-c', 'terminal-d', 'terminal-e'],
      'auto',
    );
    expect(terminalIdsInLayout(fiveTerminals.tree)).toHaveLength(5);
    expect(fiveTerminals.tree).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.6,
      first: { type: 'split', direction: 'vertical', ratio: 2 / 3 },
      second: { type: 'split', direction: 'vertical', ratio: 0.5 },
    });
  });

  it('builds equal-sized horizontal and vertical presets and focuses the active leaf', () => {
    const horizontal = createTerminalLayoutForPreset(
      ['terminal-a', 'terminal-b', 'terminal-c'],
      'horizontal',
    );
    expect(horizontal.tree).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      ratio: 2 / 3,
      first: { type: 'split', direction: 'horizontal', ratio: 0.5 },
    });

    const vertical = createTerminalLayoutForPreset(
      ['terminal-a', 'terminal-b'],
      'vertical',
    );
    expect(vertical.tree).toMatchObject({ type: 'split', direction: 'vertical', ratio: 0.5 });

    const focused = createTerminalLayoutForPreset(
      ['terminal-a', 'terminal-b'],
      'single',
    );
    expect(focused.maximizedTerminalId).toBe('terminal-a');
  });

  it('recovers missing, duplicated, and invalid saved terminal references', () => {
    const saved: TerminalWorkspaceLayout & { version: 1 } = {
      version: 1,
      tree: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'terminal', terminalId: 'removed-terminal' },
        second: { type: 'terminal', terminalId: 'terminal-a' },
      },
      activeTerminalId: 'removed-terminal',
      maximizedTerminalId: 'removed-terminal',
      closedTerminalIds: ['terminal-b', 'unknown-terminal'],
    };

    const result = reconcileTerminalLayout(saved, ['terminal-a', 'terminal-b']);

    expect(terminalIdsInLayout(result.tree)).toEqual(['terminal-a']);
    expect(result.closedTerminalIds).toEqual(['terminal-b']);
    expect(result.activeTerminalId).toBe('terminal-a');
    expect(result.maximizedTerminalId).toBeNull();
  });

  it('round-trips saved state and falls back when browser storage is malformed', () => {
    const storage = createStorage();
    const layout: TerminalWorkspaceLayout = {
      tree: splitTerminal(
        splitTerminal(null, null, 'terminal-a', 'right'),
        'terminal-a',
        'terminal-b',
        'down',
      ),
      activeTerminalId: 'terminal-b',
      maximizedTerminalId: 'terminal-a',
      closedTerminalIds: [],
    };

    saveTerminalLayout('session-a', layout, storage);
    expect(hasSavedTerminalLayout('session-a', storage)).toBe(true);
    expect(loadTerminalLayout('session-a', ['terminal-a', 'terminal-b'], 'horizontal', null, storage))
      .toEqual(layout);

    storage.setItem('devpilot-terminal-layout-v1:session-b', '{invalid');
    expect(
      loadTerminalLayout('session-b', ['terminal-a', 'terminal-b'], 'vertical', null, storage),
    ).toMatchObject({
      tree: { type: 'split', direction: 'vertical' },
      activeTerminalId: 'terminal-a',
      maximizedTerminalId: null,
    });
  });

  it.each([
    ['left', 'horizontal', 'terminal-b', 'terminal-a'],
    ['right', 'horizontal', 'terminal-a', 'terminal-b'],
    ['up', 'vertical', 'terminal-b', 'terminal-a'],
    ['down', 'vertical', 'terminal-a', 'terminal-b'],
  ] as const)(
    'places a terminal %s of its target and preserves its ID',
    (placement, direction, firstId, secondId) => {
      const original = splitTerminal(null, null, 'terminal-a', 'right');
      const result = splitTerminal(original, 'terminal-a', 'terminal-b', placement);

      expect(result).toMatchObject({
        type: 'split',
        direction,
        first: { type: 'terminal', terminalId: firstId },
        second: { type: 'terminal', terminalId: secondId },
      });
      expect(terminalIdsInLayout(result)).toEqual([firstId, secondId]);
    },
  );

  it('inserts into a nested target without changing the other branches', () => {
    const original = splitTerminal(
      splitTerminal(null, null, 'terminal-a', 'right'),
      'terminal-a',
      'terminal-b',
      'right',
    );
    const result = splitTerminal(original, 'terminal-b', 'terminal-c', 'up');

    expect(result).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'terminal', terminalId: 'terminal-a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'terminal', terminalId: 'terminal-c' },
        second: { type: 'terminal', terminalId: 'terminal-b' },
      },
    });
  });

  it('rejects a missing target rather than silently dropping the new terminal', () => {
    const tree = splitTerminal(null, null, 'terminal-a', 'right');
    expect(() => splitTerminal(tree, 'missing-terminal', 'terminal-b', 'left')).toThrow(
      'The active terminal is not present in the workspace layout.',
    );
  });
});
