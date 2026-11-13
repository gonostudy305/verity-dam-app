import { useState, useEffect, RefObject } from 'react';

export function useContainerWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState<number>(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frameId: number | null = null;

    const updateWidth = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        if (element) {
          const rect = element.getBoundingClientRect();
          setWidth(Math.floor(rect.width));
        }
      });
    };

    updateWidth();

    const resizeObserver = new ResizeObserver(() => {
      updateWidth();
    });

    resizeObserver.observe(element);

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [ref]);

  return width;
}
