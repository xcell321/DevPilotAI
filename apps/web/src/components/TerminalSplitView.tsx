import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { TerminalLayoutNode } from '../lib/terminalLayout';

interface TerminalSplitViewProps {
  node: TerminalLayoutNode;
  path?: boolean[];
  onResize: (path: boolean[], ratio: number) => void;
  renderTerminal: (terminalId: string) => ReactNode;
}

interface MinimumSize {
  width: number;
  height: number;
}

const MIN_TERMINAL_WIDTH = 320;
const MIN_TERMINAL_HEIGHT = 220;
const SPLIT_DIVIDER_SIZE = 8;
const NARROW_VIEWPORT_QUERY = '(max-width: 767px)';

/** Below the mobile breakpoint every split collapses into one vertical column. */
function stackedMinimumHeight(node: TerminalLayoutNode): number {
  if (node.type === 'terminal') return MIN_TERMINAL_HEIGHT;
  return stackedMinimumHeight(node.first) + SPLIT_DIVIDER_SIZE + stackedMinimumHeight(node.second);
}

function minimumSize(node: TerminalLayoutNode): MinimumSize {
  if (node.type === 'terminal') {
    return { width: MIN_TERMINAL_WIDTH, height: MIN_TERMINAL_HEIGHT };
  }

  const first = minimumSize(node.first);
  const second = minimumSize(node.second);
  return node.direction === 'horizontal'
    ? {
        width: first.width + SPLIT_DIVIDER_SIZE + second.width,
        height: Math.max(first.height, second.height),
      }
    : {
        width: Math.max(first.width, second.width),
        height: first.height + SPLIT_DIVIDER_SIZE + second.height,
      };
}

export function TerminalSplitView({
  node,
  path = [],
  onResize,
  renderTerminal,
}: TerminalSplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stacked = useMediaQuery(NARROW_VIEWPORT_QUERY);

  if (node.type === 'terminal') {
    return (
      <div
        className="terminal-layout-leaf h-full min-h-0 min-w-0"
        data-testid={`split-leaf-${node.terminalId}`}
      >
        {renderTerminal(node.terminalId)}
      </div>
    );
  }

  const horizontal = !stacked && node.direction === 'horizontal';
  const firstSize = minimumSize(node.first);
  const secondSize = minimumSize(node.second);
  const size = minimumSize(node);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const length = horizontal ? bounds.width : bounds.height;
    if (length <= 0) return;
    const position = horizontal
      ? event.clientX - bounds.left
      : event.clientY - bounds.top;
    onResize(path, position / length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const increase = horizontal ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
    const decrease = horizontal ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
    if (!increase && !decrease) return;
    event.preventDefault();
    onResize(path, node.ratio + (increase ? 0.03 : -0.03));
  };

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 min-w-0 ${
        horizontal
          ? 'flex-row'
          : 'flex-col'
      }`}
      style={{
        minWidth: stacked ? 0 : size.width,
        minHeight: stacked ? stackedMinimumHeight(node) : size.height,
      }}
      data-testid={`split-${path.map((branch) => (branch ? '1' : '0')).join('') || 'root'}`}
    >
      <div
        className="min-h-0 min-w-0 shrink-0"
        style={{
          flexBasis: `calc(${node.ratio * 100}% - ${node.ratio * SPLIT_DIVIDER_SIZE}px)`,
          minWidth: stacked ? 0 : firstSize.width,
          minHeight: stacked ? stackedMinimumHeight(node.first) : firstSize.height,
        }}
      >
        <TerminalSplitView
          node={node.first}
          path={[...path, true]}
          onResize={onResize}
          renderTerminal={renderTerminal}
        />
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(node.ratio * 100)}
        aria-label={`Resize ${horizontal ? 'vertical' : 'horizontal'} terminal divider`}
        tabIndex={0}
        className={`group relative z-10 shrink-0 touch-none ${
          horizontal
            ? 'w-2 cursor-col-resize'
            : 'h-2 cursor-row-resize'
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        data-testid={`split-divider-${path.map((branch) => (branch ? '1' : '0')).join('') || 'root'}`}
      >
        <span
          className={`absolute rounded-full bg-lineStrong transition-colors group-hover:bg-primary ${
            horizontal
              ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
              : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
          }`}
        />
      </div>
      <div
        className="min-h-0 min-w-0 flex-1"
        style={{
          minWidth: stacked ? 0 : secondSize.width,
          minHeight: stacked ? stackedMinimumHeight(node.second) : secondSize.height,
        }}
      >
        <TerminalSplitView
          node={node.second}
          path={[...path, false]}
          onResize={onResize}
          renderTerminal={renderTerminal}
        />
      </div>
    </div>
  );
}
