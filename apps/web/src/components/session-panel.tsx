'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiRequest } from '../lib/api';
import { EmployeeAttendance } from './employee-attendance';
import { EmployeeSchedule } from './employee-schedule';
import { EmployeeOrderWorkspace } from './employee-order-workspace';

type User = {
  id: number;
  name: string;
  role: string;
  stationId: number | null;
};
export function SessionPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    if (!process.env.NEXT_PUBLIC_API_URL) {
      setLoading(false);
      return;
    }
    apiRequest<{ user: User }>('/api/auth/me', { signal: controller.signal })
      .then((body) => {
        if (body.user?.id) setUser(body.user);
      })
      .catch((reason) => {
        if (
          !controller.signal.aborted &&
          !(reason instanceof ApiError && reason.status === 401)
        )
          setError('Unable to restore session. Please sign in again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const body = await apiRequest<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
        }),
      });
      setUser(body.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hero-card" aria-label="Account">
      {loading ? (
        <p role="status">Restoring session…</p>
      ) : user ? (
        <>
          <p>
            Signed in as {user.name} ({user.role})
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await apiRequest('/api/auth/logout', { method: 'POST' });
              } catch {
                setError('Sign-out could not be confirmed. Please try again.');
                return;
              } finally {
                setBusy(false);
              }
              setUser(null);
            }}
          >
            Sign out
          </button>
          {user.role === 'EMPLOYEE' && (
            <div key={user.id}>
              <EmployeeAttendance userId={user.id} />
              <EmployeeSchedule />
              <EmployeeOrderWorkspace
                key={`${user.id}:${user.stationId}`}
                employeeId={user.id}
                stationId={user.stationId}
              />
            </div>
          )}
        </>
      ) : (
        <form onSubmit={login}>
          <h2>Sign in</h2>
          <p>Use your existing staff or customer account.</p>
          <p>
            <label>
              Email{' '}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                disabled={busy}
              />
            </label>
          </p>
          <p>
            <label>
              Password{' '}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={busy}
              />
            </label>
          </p>
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
