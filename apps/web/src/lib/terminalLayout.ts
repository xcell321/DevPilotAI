import type { TerminalLayout } from '../../../../shared/api-types.cjs';

export type SplitDirection = 'horizontal' | 'vertical';
export type TerminalSplitPlacement = 'left' | 'right' | 'up' | 'down';

export type TerminalLayoutNode =
  | { type: 'terminal'; terminalId: string }
  | {
      type: 'split';
      direction: SplitDirection;
      ratio: number;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

export interface TerminalWorkspaceLayout {
  tree: TerminalLayoutNode | null;
  activeTerminalId: string | null;
  maximizedTerminalId: string | null;
  closedTerminalIds: string[];
}

interface PersistedTerminalWorkspaceLayout extends TerminalWorkspaceLayout {
  version: 1;
}

export interface TerminalLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TERMINAL_LAYOUT_STORAGE_PREFIX = 'devpilot-terminal-layout-v1:';

const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const MAX_LAYOUT_DEPTH = 64;

function terminalLeaf(terminalId: string): TerminalLayoutNode {
  return { type: 'terminal', terminalId };
}

function splitTerminalIds(
  terminalIds: string[],
  directionAtDepth: (depth: number) => SplitDirection,
  depth = 0,
): TerminalLayoutNode | null {
  if (terminalIds.length === 0) return null;
  if (terminalIds.length === 1) return terminalLeaf(terminalIds[0]);

  const firstIds = terminalIds.slice(0, Math.ceil(terminalIds.length / 2));
  const secondIds = terminalIds.slice(firstIds.length);
  const first = splitTerminalIds(firstIds, directionAtDepth, depth + 1);
  const second = splitTerminalIds(secondIds, directionAtDepth, depth + 1);
  if (!first || !second) return first ?? second;

  return {
    type: 'split',
    direction: directionAtDepth(depth),
    ratio: firstIds.length / terminalIds.length,
    first,
    second,
  };
}

export function terminalIdsInLayout(tree: TerminalLayoutNode | null): string[] {
  if (!tree) return [];
  if (tree.type === 'terminal') return [tree.terminalId];
  return [
    ...terminalIdsInLayout(tree.first),
    ...terminalIdsInLayout(tree.second),
  ];
}

export function createTerminalLayout(
  terminalIds: string[],
  direction: SplitDirection = 'horizontal',
): TerminalWorkspaceLayout {
  return {
    tree: splitTerminalIds(terminalIds, () => direction),
    activeTerminalId: terminalIds[0] ?? null,
    maximizedTerminalId: null,
    closedTerminalIds: [],
  };
}

export function createTerminalLayoutForPreset(
  terminalIds: string[],
  preset: TerminalLayout,
  maximizedTerminalId: string | null = null,
): TerminalWorkspaceLayout {
  const directionForPreset = (depth: number): SplitDirection => {
    if (preset === 'horizontal') return 'horizontal';
    if (preset === 'vertical') return 'vertical';
    return depth % 2 === 0 ? 'horizontal' : 'vertical';
  };
  const activeTerminalId = terminalIds[0] ?? null;
  const tree = splitTerminalIds(terminalIds, directionForPreset);
  const savedMaximizedId =
    maximizedTerminalId && terminalIds.includes(maximizedTerminalId)
      ? maximizedTerminalId
      : null;

  return {
    tree,
    activeTerminalId,
    maximizedTerminalId:
      savedMaximizedId ?? (preset === 'single' ? activeTerminalId : null),
    closedTerminalIds: [],
  };
}

function parseTree(
  value: unknown,
  allowedIds: Set<string>,
  usedIds: Set<string>,
  depth: number,
): TerminalLayoutNode | null {
  if (!value || typeof value !== 'object' || depth > MAX_LAYOUT_DEPTH) return null;
  const node = value as Record<string, unknown>;

  if (node.type === 'terminal') {
    if (
      typeof node.terminalId !== 'string' ||
      !allowedIds.has(node.terminalId) ||
      usedIds.has(node.terminalId)
    ) {
      return null;
    }
    usedIds.add(node.terminalId);
    return terminalLeaf(node.terminalId);
  }

  if (
    node.type !== 'split' ||
    (node.direction !== 'horizontal' && node.direction !== 'vertical') ||
    typeof node.ratio !== 'number' ||
    !Number.isFinite(node.ratio)
  ) {
    return null;
  }

  const first = parseTree(node.first, allowedIds, usedIds, depth + 1);
  const second = parseTree(node.second, allowedIds, usedIds, depth + 1);
  if (!first) return second;
  if (!second) return first;
  return {
    type: 'split',
    direction: node.direction,
    ratio: Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, node.ratio)),
    first,
    second,
  };
}

export function reconcileTerminalLayout(
  value: unknown,
  terminalIds: string[],
  defaultDirection: SplitDirection = 'horizontal',
): TerminalWorkspaceLayout {
  const allowedIds = new Set(terminalIds);
  if (!value || typeof value !== 'object') {
    return createTerminalLayout(terminalIds, defaultDirection);
  }

  const saved = value as Record<string, unknown>;
  if (saved.version !== 1 || !Array.isArray(saved.closedTerminalIds)) {
    return createTerminalLayout(terminalIds, defaultDirection);
  }

  const closedTerminalIds = saved.closedTerminalIds.filter(
    (id): id is string => typeof id === 'string' && allowedIds.has(id),
  );
  const closedIds = new Set(closedTerminalIds);
  const visibleIds = new Set([...allowedIds].filter((id) => !closedIds.has(id)));
  const usedIds = new Set<string>();
  let tree = parseTree(saved.tree, visibleIds, usedIds, 0);

  for (const id of visibleIds) {
    if (usedIds.has(id)) continue;
    const leaf = terminalLeaf(id);
    tree = tree
      ? { type: 'split', direction: defaultDirection, ratio: 0.5, first: tree, second: leaf }
      : leaf;
  }

  const layoutIds = new Set(terminalIdsInLayout(tree));
  const activeTerminalId =
    typeof saved.activeTerminalId === 'string' && layoutIds.has(saved.activeTerminalId)
      ? saved.activeTerminalId
      : terminalIdsInLayout(tree)[0] ?? null;
  const maximizedTerminalId =
    typeof saved.maximizedTerminalId === 'string' &&
    layoutIds.has(saved.maximizedTerminalId)
      ? saved.maximizedTerminalId
      : null;

  return {
    tree,
    activeTerminalId,
    maximizedTerminalId,
    closedTerminalIds: [...closedIds],
  };
}

export function splitTerminal(
  tree: TerminalLayoutNode | null,
  targetTerminalId: string | null,
  newTerminalId: string,
  placement: TerminalSplitPlacement,
): TerminalLayoutNode {
  if (!tree) return terminalLeaf(newTerminalId);
  if (!targetTerminalId || !terminalIdsInLayout(tree).includes(targetTerminalId)) {
    throw new Error('The active terminal is not present in the workspace layout.');
  }
  const direction: SplitDirection =
    placement === 'left' || placement === 'right' ? 'horizontal' : 'vertical';
  const insertFirst = placement === 'left' || placement === 'up';
  const insert = (node: TerminalLayoutNode): TerminalLayoutNode => {
    if (node.type === 'terminal') {
      if (node.terminalId !== targetTerminalId) return node;
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        first: insertFirst ? terminalLeaf(newTerminalId) : node,
        second: insertFirst ? node : terminalLeaf(newTerminalId),
      };
    }

    const first = insert(node.first);
    if (first !== node.first) return { ...node, first };
    const second = insert(node.second);
    return second === node.second ? node : { ...node, second };
  };
  return insert(tree);
}

export function removeTerminal(
  tree: TerminalLayoutNode | null,
  terminalId: string,
): TerminalLayoutNode | null {
  if (!tree) return null;
  if (tree.type === 'terminal') {
    return tree.terminalId === terminalId ? null : tree;
  }
  const first = removeTerminal(tree.first, terminalId);
  const second = removeTerminal(tree.second, terminalId);
  if (!first) return second;
  if (!second) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

export function resizeTerminalSplit(
  tree: TerminalLayoutNode | null,
  path: boolean[],
  ratio: number,
): TerminalLayoutNode | null {
  if (!tree || tree.type !== 'split') return tree;
  const boundedRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  if (path.length === 0) return { ...tree, ratio: boundedRatio };
  const [first, ...rest] = path;
  if (first) {
    return { ...tree, first: resizeTerminalSplit(tree.first, rest, ratio) ?? tree.first };
  }
  return { ...tree, second: resizeTerminalSplit(tree.second, rest, ratio) ?? tree.second };
}

export function loadTerminalLayout(
  sessionId: string,
  terminalIds: string[],
  defaultDirection: SplitDirection = 'horizontal',
  legacyMaximizedTerminalId: string | null = null,
  storage?: TerminalLayoutStorage,
): TerminalWorkspaceLayout {
  try {
    const raw = (storage ?? window.localStorage).getItem(
      `${TERMINAL_LAYOUT_STORAGE_PREFIX}${sessionId}`,
    );
    if (!raw) {
      const layout = createTerminalLayout(terminalIds, defaultDirection);
      return layout.tree && terminalIds.includes(legacyMaximizedTerminalId ?? '')
        ? { ...layout, maximizedTerminalId: legacyMaximizedTerminalId }
        : layout;
    }
    return reconcileTerminalLayout(JSON.parse(raw), terminalIds, defaultDirection);
  } catch {
    return createTerminalLayout(terminalIds, defaultDirection);
  }
}

export function hasSavedTerminalLayout(
  sessionId: string,
  storage?: Pick<TerminalLayoutStorage, 'getItem'>,
): boolean {
  try {
    return (storage ?? window.localStorage).getItem(
      `${TERMINAL_LAYOUT_STORAGE_PREFIX}${sessionId}`,
    ) !== null;
  } catch {
    return false;
  }
}

export function saveTerminalLayout(
  sessionId: string,
  layout: TerminalWorkspaceLayout,
  storage?: Pick<TerminalLayoutStorage, 'setItem'>,
): void {
  try {
    const persisted: PersistedTerminalWorkspaceLayout = { version: 1, ...layout };
    (storage ?? window.localStorage).setItem(
      `${TERMINAL_LAYOUT_STORAGE_PREFIX}${sessionId}`,
      JSON.stringify(persisted),
    );
  } catch {
    // The workspace remains usable when browser storage is unavailable.
  }
}
