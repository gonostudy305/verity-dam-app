'use client';

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';

interface TopbarPortalProps {
  children: React.ReactNode;
}

export function TopbarPortal({ children }: TopbarPortalProps) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.getElementById('topbar-portal-slot');
    setTarget(el);
  }, []);

  if (!target) return null;
  return ReactDOM.createPortal(children, target);
}
