'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import {
  currentShiftWeek,
  localShiftTime,
  moveShiftWeek,
  SHIFT_TIMEZONE,
} from '../lib/shift-week';

type Schedule = {
  weekStart: string;
  timezone: string;
  from: string;
  to: string;
  shifts: {
    id: number;
    startsAt: string;
    endsAt: string;
    station: { id: number; name: string; isActive: boolean };
  }[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};
type View = {
  key: string;
  loading: boolean;
  data: Schedule | null;
  error: string;
};

export function EmployeeSchedule() {
  const [query, setQuery] = useState(() => ({
    weekStart: currentShiftWeek(),
    page: 1,
  }));
  const [retry, setRetry] = useState(0);
  const key = `${query.weekStart}:${query.page}`;
  const [view, setView] = useState<View>({
    key: '',
    loading: true,
    data: null,
    error: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    const requestKey = `${query.weekStart}:${query.page}`;
    setView({ key: requestKey, loading: true, data: null, error: '' });
    apiRequest<Schedule>(
      `/api/employee/shifts?weekStart=${query.weekStart}&page=${query.page}&limit=20`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setView({ key: requestKey, loading: false, data, error: '' });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setView({
            key: requestKey,
            loading: false,
            data: null,
            error:
              reason instanceof Error
                ? reason.message
                : 'Unable to load schedule',
          });
      });
    return () => controller.abort();
  }, [query.weekStart, query.page, retry]);
  const current =
    view.key === key ? view : { loading: true, data: null, error: '' };
  const data = current.data;
  function changeWeek(weeks: number) {
    setQuery((previous) => ({
      weekStart: moveShiftWeek(previous.weekStart, weeks),
      page: 1,
    }));
  }
  return (
    <section aria-labelledby="schedule-heading">
      <h2 id="schedule-heading">Your weekly schedule</h2>
      <p>
        Week starting {query.weekStart} ({SHIFT_TIMEZONE})
      </p>
      <nav aria-label="Schedule week">
        <button type="button" onClick={() => changeWeek(-1)}>
          Previous week
        </button>
        <button
          type="button"
          onClick={() => setQuery({ weekStart: currentShiftWeek(), page: 1 })}
        >
          This week
        </button>
        <button type="button" onClick={() => changeWeek(1)}>
          Next week
        </button>
      </nav>
      {current.loading && <p role="status">Loading schedule…</p>}
      {current.error && (
        <>
          <p role="alert">Schedule could not be loaded: {current.error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry schedule
          </button>
        </>
      )}
      {data && (
        <>
          {data.shifts.length === 0 ? (
            <p>No shifts on this page for the selected week.</p>
          ) : (
            <ul aria-label="Weekly shifts">
              {data.shifts.map((shift) => (
                <li key={shift.id}>
                  <strong>
                    {shift.station.name}
                    {shift.station.isActive ? '' : ' (inactive)'}
                  </strong>
                  <p>
                    <time dateTime={shift.startsAt}>
                      {localShiftTime(shift.startsAt)}
                    </time>{' '}
                    to{' '}
                    <time dateTime={shift.endsAt}>
                      {localShiftTime(shift.endsAt)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p>
            Page {data.pagination.page} of{' '}
            {Math.max(1, data.pagination.totalPages)} · {data.pagination.total}{' '}
            shifts
          </p>
          <nav aria-label="Schedule pages">
            <button
              type="button"
              disabled={query.page <= 1}
              onClick={() =>
                setQuery((previous) => ({
                  ...previous,
                  page: previous.page - 1,
                }))
              }
            >
              Previous page
            </button>
            <button
              type="button"
              disabled={query.page >= data.pagination.totalPages}
              onClick={() =>
                setQuery((previous) => ({
                  ...previous,
                  page: previous.page + 1,
                }))
              }
            >
              Next page
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
