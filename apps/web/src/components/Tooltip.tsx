import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  children: React.ReactElement;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 150,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [positionStyles, setPositionStyles] = useState<React.CSSProperties>({});
  const childRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setVisible(true);
      updatePosition();
    }, delay);
  };

  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setVisible(false);
  };

  const updatePosition = () => {
    if (!childRef.current || !tooltipRef.current) return;
    const childRect = childRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const gap = 6;

    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = childRect.top - tooltipRect.height - gap;
        left = childRect.left + (childRect.width - tooltipRect.width) / 2;
        break;
      case 'bottom':
        top = childRect.bottom + gap;
        left = childRect.left + (childRect.width - tooltipRect.width) / 2;
        break;
      case 'left':
        top = childRect.top + (childRect.height - tooltipRect.height) / 2;
        left = childRect.left - tooltipRect.width - gap;
        break;
      case 'right':
        top = childRect.top + (childRect.height - tooltipRect.height) / 2;
        left = childRect.right + gap;
        break;
    }

    // Keep tooltip in viewport
    const viewportPadding = 8;
    if (left < viewportPadding) left = viewportPadding;
    if (left + tooltipRect.width > window.innerWidth - viewportPadding) {
      left = window.innerWidth - tooltipRect.width - viewportPadding;
    }
    if (top < viewportPadding) top = viewportPadding;

    setPositionStyles({ top: Math.round(top), left: Math.round(left) });
  };

  useEffect(() => {
    if (visible) {
      updatePosition();
      const handleResize = () => updatePosition();
      window.addEventListener('resize', handleResize);
      window.addEventListener('scroll', handleResize, true);
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('scroll', handleResize, true);
      };
    }
  }, [visible]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const tooltip = visible ? (
    <div
      ref={tooltipRef}
      className="fixed z-50 pointer-events-none text-[10px] font-medium text-ink bg-brass px-2 py-1 rounded shadow-lg whitespace-nowrap animate-tooltip-in"
      style={positionStyles}
      role="tooltip"
      aria-hidden="true"
    >
      {content}
    </div>
  ) : null;

  // We need to wrap the child in a fragment to attach events without modifying props
  // Use a wrapper span to hold the ref and events
  return (
    <>
      <span
        ref={childRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {createPortal(tooltip, document.body)}
    </>
  );
}