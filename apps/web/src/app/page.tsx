'use client';

import { useEffect, useState } from 'react';

type ApiStatus = 'checking' | 'connected' | 'unavailable' | 'unconfigured';

function isHealthResponse(value: unknown): value is { status: 'ok' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok'
  );
}

export default function HomePage() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    let active = true;

    if (!apiUrl) {
      setApiStatus('unconfigured');
      return () => {
        active = false;
      };
    }

    const checkApiHealth = async () => {
      try {
        const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/health`);
        const body: unknown = await response.json();

        if (!response.ok || !isHealthResponse(body)) {
          throw new Error('API health check failed');
        }

        if (active) {
          setApiStatus('connected');
        }
      } catch {
        if (active) {
          setApiStatus('unavailable');
        }
      }
    };

    void checkApiHealth();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">System foundation</p>
        <h1>Smart Fuel Stations Monitoring &amp; Management System</h1>
        <p>Frontend is running.</p>
        <p>
          The project is initialized with a clean frontend and backend
          foundation for future monitoring, analytics, and operational features.
        </p>
        <p aria-live="polite">
          Backend status:{' '}
          {apiStatus === 'checking'
            ? 'Checking...'
            : apiStatus === 'connected'
              ? 'Connected'
              : apiStatus === 'unconfigured'
                ? 'URL not configured'
                : 'Unavailable'}
        </p>
      </section>
    </main>
  );
}
