'use client';

import { useCallback, useState } from 'react';
import { EmployeeOrders, type EmployeeQueueOrder } from './employee-orders';

export function EmployeeOrderWorkspace(props: {
  employeeId: number;
  stationId: number | null;
}) {
  return (
    <StationOrders key={`${props.employeeId}:${props.stationId}`} {...props} />
  );
}

function StationOrders(props: {
  employeeId: number;
  stationId: number | null;
}) {
  const [stationId, setStationId] = useState(props.stationId);
  const [refreshVersion, refresh] = useState(0);
  const [result, setResult] = useState<{
    stationId: number;
    order: EmployeeQueueOrder;
  } | null>(null);
  const [message, setMessage] = useState('');
  const clear = useCallback((next?: number | null) => {
    setResult(null);
    setMessage('');
    if (next !== undefined) setStationId(next);
  }, []);
  const acted = useCallback((next: typeof result, notice: string) => {
    setResult(next);
    setMessage(notice);
    refresh((value) => value + 1);
  }, []);
  return (
    <>
      <EmployeeOrders
        employeeId={props.employeeId}
        stationId={stationId}
        onAction={acted}
        onAssignmentChange={clear}
        refreshVersion={refreshVersion}
      />
      <EmployeeOrders
        employeeId={props.employeeId}
        stationId={stationId}
        mode="mine"
        onAction={acted}
        onAssignmentChange={clear}
        refreshVersion={refreshVersion}
      />
      {message && <p role="status">{message}</p>}
      {result && (
        <section aria-label="Last order action">
          <h2>Last order update</h2>
          <p>
            Station {result.stationId} · Order {result.order.id} ·{' '}
            {result.order.status}
          </p>
          <p>
            Pump {result.order.pump.number} · {result.order.fuelType.name} ·
            Requested volume: {result.order.orderedVolume}
          </p>
        </section>
      )}
    </>
  );
}
