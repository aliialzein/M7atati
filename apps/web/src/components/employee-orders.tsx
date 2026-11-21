'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '../lib/api';

export type EmployeeQueueOrder = {
  id: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
  createdAt: string;
  orderedVolume: string;
  pump: { id: number; number: number };
  fuelType: { id: number; name: string; code: string };
};
type Queue = {
  dataSource: 'database';
  stationId: number;
  orders: EmployeeQueueOrder[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};
type View = {
  owner: string;
  page: number;
  data: Queue | null;
  loading: boolean;
  error: string;
  updatedAt: string | null;
};
type Profile = { user: { id: number; role: string; stationId: number | null } };

export function EmployeeOrders({
  employeeId,
  stationId,
  mode = 'pending',
  refreshVersion = 0,
  onAction,
  onAssignmentChange,
}: {
  employeeId: number;
  stationId: number | null;
  mode?: 'pending' | 'mine';
  refreshVersion?: number;
  onAction?: (
    result: { stationId: number; order: EmployeeQueueOrder } | null,
    message: string,
  ) => void;
  onAssignmentChange?: (stationId?: number | null) => void;
}) {
  const mine = mode === 'mine';
  const label = mine ? 'my work' : 'pending orders';
  const [acting, setActing] = useState<number | null>(null);
  const actionBusy = useRef(false);
  const actionController = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const owner = `${employeeId}:${stationId}`;
  const lastOwner = useRef(owner);
  const knownStation = useRef(stationId);
  const [view, setView] = useState<View>({
    owner: '',
    page: 1,
    data: null,
    loading: true,
    error: '',
    updatedAt: null,
  });
  useEffect(() => {
    function invalidateAction() {
      epoch.current++;
      actionController.current?.abort();
    }
    actionBusy.current = false;
    setActing(null);
    if (lastOwner.current !== owner) {
      lastOwner.current = owner;
      knownStation.current = stationId;
      setView({
        owner,
        page: 1,
        data: null,
        loading: true,
        error: '',
        updatedAt: null,
      });
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    let active = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setView((previous) => ({
      owner,
      page,
      loading: true,
      error: '',
      data:
        previous.owner === owner && previous.page === page
          ? previous.data
          : null,
      updatedAt:
        previous.owner === owner && previous.page === page
          ? previous.updatedAt
          : null,
    }));
    const visible = () => document.visibilityState !== 'hidden';
    function clearData() {
      setView({
        owner,
        page,
        data: null,
        loading: true,
        error: '',
        updatedAt: null,
      });
    }
    async function load() {
      if (!active || busy || actionBusy.current || !visible()) return;
      clearTimeout(timer);
      busy = true;
      try {
        // Revalidate session/assignment before every poll. Identity/station never
        // enter queue query parameters. The API independently checks assignment.
        const profile = await apiRequest<Profile>('/api/auth/me', {
          signal: controller.signal,
        });
        if (!active) return;
        if (profile.user.id !== employeeId || profile.user.role !== 'EMPLOYEE')
          throw new ApiError(403, 'Employee session changed. Sign in again.');
        if (profile.user.stationId !== knownStation.current) {
          invalidateAction();
          onAssignmentChange?.(profile.user.stationId);
          knownStation.current = profile.user.stationId;
          clearData();
          if (page !== 1) {
            setPage(1);
            return;
          }
        }
        if (profile.user.stationId === null)
          throw new ApiError(
            409,
            'An assigned station is required to view pending orders',
          );
        const data = await apiRequest<Queue>(
          mine
            ? `/api/employee/orders/mine?status=IN_PROGRESS&page=${page}&limit=20`
            : `/api/employee/orders?status=PENDING&page=${page}&limit=20`,
          { signal: controller.signal },
        );
        if (!active) return;
        // A transfer can commit between /me and the queue snapshot.
        if (data.stationId !== knownStation.current) {
          invalidateAction();
          onAssignmentChange?.(data.stationId);
          knownStation.current = data.stationId;
          clearData();
          if (page !== 1) {
            setPage(1);
            return;
          }
        }
        if (page > 1 && page > Math.max(1, data.pagination.totalPages)) {
          clearData();
          setPage(Math.max(1, data.pagination.totalPages));
          return;
        }
        setView({
          owner,
          page,
          data,
          loading: false,
          error: '',
          updatedAt: new Date().toISOString(),
        });
      } catch (reason) {
        if (!active) return;
        const denied =
          reason instanceof ApiError && [401, 403, 409].includes(reason.status);
        if (denied) onAssignmentChange?.();
        setView((previous) => {
          const data =
            !denied &&
            previous.owner === owner &&
            previous.page === page &&
            previous.data?.stationId === knownStation.current
              ? previous.data
              : null;
          return {
            owner,
            page,
            data,
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : 'Unable to load pending orders',
            updatedAt: data ? previous.updatedAt : null,
          };
        });
      } finally {
        busy = false;
        if (active && visible())
          timer = setTimeout(() => {
            void load();
          }, 5000);
      }
    }
    const focus = () => {
      void load();
    };
    const visibility = () => {
      clearTimeout(timer);
      if (visible()) void load();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => {
      active = false;
      invalidateAction();
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [
    employeeId,
    stationId,
    owner,
    page,
    retry,
    refreshVersion,
    mine,
    onAssignmentChange,
  ]);
  const current =
    view.owner === owner && view.page === page
      ? view
      : { data: null, loading: true, error: '', updatedAt: null };
  const data = current.data;
  async function actOnOrder(id: number) {
    if (actionBusy.current || !data) return;
    actionBusy.current = true;
    setActing(id);
    const generation = epoch.current;
    const actionStation = data.stationId;
    const controller = new AbortController();
    actionController.current = controller;
    try {
      const result = await apiRequest<{
        stationId: number;
        order: EmployeeQueueOrder;
      }>(`/api/employee/orders/${id}/${mine ? 'complete' : 'claim'}`, {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      });
      if (epoch.current !== generation) return;
      // An action may have committed before a transfer/logout. Revalidate before
      // publishing its response to the current screen.
      const profile = await apiRequest<Profile>('/api/auth/me', {
        signal: controller.signal,
      });
      if (epoch.current !== generation) return;
      if (
        profile.user.id !== employeeId ||
        profile.user.role !== 'EMPLOYEE' ||
        profile.user.stationId !== actionStation ||
        result.stationId !== actionStation
      ) {
        onAssignmentChange?.(profile.user.stationId);
        return;
      }
      onAction?.(result, `Order ${id}: ${result.order.status}`);
    } catch (reason) {
      if (epoch.current !== generation) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status))
        onAssignmentChange?.();
      onAction?.(
        null,
        reason instanceof ApiError && reason.status === 409
          ? 'The order is no longer available or its status changed. Lists refreshed.'
          : 'Order action could not be confirmed. Lists refreshed; retrying the same action is safe.',
      );
    } finally {
      if (epoch.current === generation) {
        actionBusy.current = false;
        setActing(null);
        setRetry((value) => value + 1);
      }
    }
  }
  return (
    <section aria-labelledby={mine ? 'my-work-heading' : 'orders-heading'}>
      <h2 id={mine ? 'my-work-heading' : 'orders-heading'}>
        {mine ? 'My work' : 'Pending orders'}
      </h2>
      {current.loading && <p role="status">Loading {label}…</p>}
      {current.error && (
        <>
          <p role="alert">
            {mine ? 'My work' : 'Pending orders'} could not be refreshed:{' '}
            {current.error}
          </p>
          {data && (
            <p role="status">
              Showing the last successful result. It may be out of date.
            </p>
          )}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry {label}
          </button>
        </>
      )}
      {data && (
        <>
          <p>
            Station {data.stationId} · {data.pagination.total}{' '}
            {mine ? 'orders in progress' : 'pending orders'}
          </p>
          {data.orders.length === 0 ? (
            <p>
              {mine
                ? 'No work in progress on this page.'
                : 'No pending orders on this page.'}
            </p>
          ) : (
            <ul aria-label={mine ? 'My work orders' : 'Pending order queue'}>
              {data.orders.map((order) => (
                <li key={order.id}>
                  <strong>
                    Order {order.id} · {order.status}
                  </strong>
                  <p>
                    Pump {order.pump.number} · {order.fuelType.name} (
                    {order.fuelType.code}) · Requested volume:{' '}
                    {order.orderedVolume}
                  </p>
                  {onAction && (
                    <button
                      type="button"
                      disabled={acting !== null}
                      onClick={() => void actOnOrder(order.id)}
                    >
                      {acting === order.id
                        ? 'Saving…'
                        : mine
                          ? `Complete order ${order.id}`
                          : `Claim order ${order.id}`}
                    </button>
                  )}
                  <p>
                    Created{' '}
                    <time dateTime={order.createdAt}>
                      {new Date(order.createdAt).toLocaleString('en-GB', {
                        timeZone: 'Asia/Beirut',
                      })}{' '}
                      (Asia/Beirut)
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {current.updatedAt && (
            <p>
              Last updated{' '}
              {new Date(current.updatedAt).toLocaleTimeString('en-GB', {
                timeZone: 'Asia/Beirut',
              })}{' '}
              (Asia/Beirut)
            </p>
          )}
          <p>
            {mine ? 'My work page' : 'Queue page'} {data.pagination.page} of{' '}
            {Math.max(1, data.pagination.totalPages)}
          </p>
          <nav aria-label={mine ? 'My work pages' : 'Pending order pages'}>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              {mine ? 'Previous work page' : 'Previous order page'}
            </button>
            <button
              type="button"
              disabled={page >= data.pagination.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              {mine ? 'Next work page' : 'Next order page'}
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
