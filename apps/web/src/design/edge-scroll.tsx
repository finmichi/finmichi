// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  IconChevronDown,
  IconChevronUp,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
export function EdgeScroll({
  children,
  axis = 'y',
  label,
  className = '',
}: {
  children: ReactNode;
  axis?: 'x' | 'y' | 'both';
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({
      top: el.scrollTop > 1,
      bottom: el.scrollHeight - el.clientHeight - el.scrollTop > 1,
      left: el.scrollLeft > 1,
      right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1,
    });
  }, []);
  useEffect(() => {
    const el = ref.current,
      child = content.current;
    if (!el || !child) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(child);
    update();
    return () => observer.disconnect();
  }, [update]);
  function scroll(direction: 'top' | 'bottom' | 'left' | 'right') {
    const el = ref.current;
    if (!el) return;
    const horizontal = direction === 'left' || direction === 'right';
    el.scrollBy({
      left: horizontal
        ? el.clientWidth * 0.8 * (direction === 'left' ? -1 : 1)
        : 0,
      top: horizontal
        ? 0
        : el.clientHeight * 0.8 * (direction === 'top' ? -1 : 1),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  const directions = [
    ['top', '向上捲動', IconChevronUp],
    ['bottom', '向下捲動', IconChevronDown],
    ['left', '向左捲動', IconChevronLeft],
    ['right', '向右捲動', IconChevronRight],
  ] as const;
  return (
    <div className={'edge-scroll ' + className} data-axis={axis}>
      <div
        ref={ref}
        className="edge-viewport"
        tabIndex={0}
        role="region"
        aria-label={label}
        onScroll={update}
      >
        <div ref={content} className="edge-content">
          {children}
        </div>
      </div>
      {directions.map(([direction, text, Icon]) =>
        edges[direction] &&
        (axis === 'both' ||
          (direction === 'left' || direction === 'right'
            ? axis === 'x'
            : axis === 'y')) ? (
          <button
            key={direction}
            type="button"
            className={'edge-arrow edge-' + direction}
            tabIndex={-1}
            aria-label={text}
            onClick={() => scroll(direction)}
          >
            <Icon size={14} stroke={2} />
          </button>
        ) : null,
      )}
    </div>
  );
}
