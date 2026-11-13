'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { apiRequest } from '@/lib/client/api';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    apiRequest<{ authenticated: boolean }>('/api/auth/session')
      .then((res) => {
        if (!active) return;
        if (res.authenticated) {
          router.replace('/library');
        } else {
          router.replace('/login');
        }
      })
      .catch(() => {
        if (active) {
          router.replace('/login');
        }
      });
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-paper text-text-3">
      <Loader2 className="w-6 h-6 animate-spin text-verity" />
    </div>
  );
}
