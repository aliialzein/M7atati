import { useState } from "react";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import {
  Card,
  DateFields,
  Resource,
  Table,
  Title,
} from "../../components/ui.jsx";
import { humanize, iso } from "../../lib/format.js";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";

function StationAnalytics({ station }) {
  const [filters, setFilters] = useState({ from: "", to: "" });
  const invalid = filters.from && filters.to && filters.from >= filters.to;
  const result = useResource(
    invalid
      ? null
      : query(`/manager/stations/${station.id}/analytics`, {
          from: iso(filters.from),
          to: iso(filters.to),
        }),
  );
  return (
    <>
      <Title title="Station analytics" description={station.name} />
      <Card title="Reporting period">
        <div className="filters">
          <DateFields
            {...filters}
            onChange={(key, value) =>
              setFilters((current) => ({ ...current, [key]: value }))
            }
          />
        </div>
        {invalid && (
          <p className="notice error" role="alert">
            The end date must be after the start date.
          </p>
        )}
      </Card>
      <Resource result={result}>
        {({ attendance, orders }) => (
          <>
            <div className="card-grid">
              {[
                ["Orders", orders.totalOrders],
                ["Attendance records", attendance.totalRecords],
                ["Open attendance", attendance.openRecords],
                ["Closed attendance", attendance.closedRecords],
              ].map(([label, value]) => (
                <Card key={label} title={label}>
                  <p className="stat">{value}</p>
                </Card>
              ))}
            </div>
            <Card title="Orders by status">
              <Table
                columns={["Status", "Orders"]}
                rows={Object.entries(orders.countsByStatus).map(
                  ([status, value]) => ({
                    id: status,
                    cells: [humanize(status), value],
                  }),
                )}
              />
            </Card>
          </>
        )}
      </Resource>
    </>
  );
}
export default function AnalyticsPage() {
  return (
    <ManagedStation>
      {(station) => <StationAnalytics station={station} />}
    </ManagedStation>
  );
}
