'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('verity-theme') as Theme | null;
    if (saved === 'dark' || saved === 'light') {
      setThemeState(saved);
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      setThemeState('light');
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem('verity-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-[12px] font-medium text-text-2 transition-all hover:bg-surface hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity md:h-[34px] md:min-h-0',
        className
      )}
      title="Đổi giao diện Sáng / Tối"
    >
      {theme === 'dark' ? (
        <>
          <Moon className="w-3.5 h-3.5 text-verity" />
          <span>Ban đêm</span>
        </>
      ) : (
        <>
          <Sun className="w-3.5 h-3.5 text-gold-ink" />
          <span>Ban ngày</span>
        </>
      )}
    </button>
  );
}
