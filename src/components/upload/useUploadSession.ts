'use client';

import { useCallback, useRef } from 'react';

const STORAGE_KEY = 'verity-media:upload-session';
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface UploadSessionEntry {
  taskId: string;
  assetId: string;
  fileName: string;
  completedAt: string;
}

interface PersistedSession {
  entries: UploadSessionEntry[];
  savedAt: string;
}

function readSession(): UploadSessionEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: PersistedSession = JSON.parse(raw);
    const age = Date.now() - new Date(parsed.savedAt).getTime();
    if (age > SESSION_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

function writeSession(entries: UploadSessionEntry[]) {
  if (typeof window === 'undefined') return;
  if (entries.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const session: PersistedSession = { entries, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function useUploadSession() {
  const entriesRef = useRef<UploadSessionEntry[]>([]);

  const save = useCallback((entries: UploadSessionEntry[]) => {
    entriesRef.current = entries;
    writeSession(entries);
  }, []);

  const load = useCallback((): UploadSessionEntry[] => {
    const entries = readSession();
    entriesRef.current = entries;
    return entries;
  }, []);

  const remove = useCallback((assetId: string) => {
    const updated = entriesRef.current.filter((e) => e.assetId !== assetId);
    entriesRef.current = updated;
    writeSession(updated);
  }, []);

  const clear = useCallback(() => {
    entriesRef.current = [];
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return { save, load, remove, clear };
}
