'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../lib/api';

type Station = { id: number; name: string; isActive: boolean };
type Record = {
  id: number;
  stationId: number;
  clockInAt: string;
  clockOutAt: string | null;
  station: Station;
};
type Attendance = {
  state: 'CHECKED_IN' | 'CHECKED_OUT';
  openRecord: Record | null;
  assignedStation: Station | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
};
type Attempt =
  | { kind: 'check-in'; requestId: string }
  | { kind: 'check-out'; recordId: number };
const path = '/api/employee/attendance';

export function EmployeeAttendance({ userId }: { userId: number }) {
  const [current, setCurrent] = useState<Attendance | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = `employee-attendance-attempt:${userId}`;
  const reconcile = useCallback(async () => {
    setCurrent(await apiRequest<Attendance>(`${path}/current`));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (saved?.kind === 'check-in' && typeof saved.requestId === 'string')
        setAttempt(saved);
      else if (
        saved?.kind === 'check-out' &&
        Number.isInteger(saved.recordId) &&
        saved.recordId > 0
      )
        setAttempt(saved);
    } catch {
      /* Invalid saved state is ignored; server remains authoritative. */
    }
    apiRequest<Attendance>(`${path}/current`, { signal: controller.signal })
      .then(setCurrent)
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason.message ?? 'Unable to load attendance');
      });
    return () => controller.abort();
  }, [key]);

  function persist(value: Attempt | null) {
    // Refuse to submit a new attempt if its retry identity cannot be retained.
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    setAttempt(value);
  }

  async function act() {
    if (busy || !current) return;
    setBusy(true);
    setError('');
    let acknowledged = false;
    try {
      const next =
        attempt ??
        (current.openRecord
          ? { kind: 'check-out' as const, recordId: current.openRecord.id }
          : { kind: 'check-in' as const, requestId: crypto.randomUUID() });
      persist(next);
      await apiRequest(
        next.kind === 'check-in'
          ? `${path}/check-in`
          : `${path}/${next.recordId}/check-out`,
        {
          method: 'POST',
          body: JSON.stringify(
            next.kind === 'check-in' ? { requestId: next.requestId } : {},
          ),
        },
      );
      acknowledged = true;
      persist(null);
      setCurrent(null);
      await reconcile();
    } catch (reason) {
      const definitive = reason instanceof ApiError && reason.status < 500;
      if (definitive) persist(null);
      setError(
        acknowledged
          ? 'Action saved. Reload attendance to see the latest state.'
          : definitive
            ? reason.message
            : 'Could not confirm the action. Retry to confirm the same attendance attempt.',
      );
      try {
        await reconcile();
      } catch {
        /* Keep the error and retry identity. */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="attendance-heading">
      <h2 id="attendance-heading">Your attendance</h2>
      {current && (
        <>
          <p>
            Assigned station: {current.assignedStation?.name ?? 'Not assigned'}
            {current.assignedStation && !current.assignedStation.isActive
              ? ' (inactive)'
              : ''}
          </p>
          <p role="status">
            {current.state === 'CHECKED_IN' ? 'Checked in' : 'Checked out'}
          </p>
          {current.openRecord && (
            <p>
              Checked in at {current.openRecord.station.name} on{' '}
              {new Date(current.openRecord.clockInAt).toLocaleString('en-GB', {
                timeZone: 'Asia/Beirut',
              })}{' '}
              (Asia/Beirut)
            </p>
          )}
          {attempt && (
            <p>
              An attendance action needs confirmation. Retrying keeps the
              original attempt.
            </p>
          )}
          <button
            type="button"
            disabled={
              busy || (!attempt && !current.canCheckIn && !current.canCheckOut)
            }
            onClick={act}
          >
            {busy
              ? 'Saving…'
              : attempt
                ? `Retry ${attempt.kind === 'check-in' ? 'check-in' : 'check-out'}`
                : current.openRecord
                  ? 'Check out'
                  : 'Check in'}
          </button>
          {!current.canCheckIn && !current.openRecord && !attempt && (
            <p>
              Check-in requires an active assigned station and attendance
              access.
            </p>
          )}
        </>
      )}
      {!current && !error && <p role="status">Loading attendance…</p>}
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          reconcile()
            .catch((reason) => setError(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        Reload attendance
      </button>
    </section>
  );
}
