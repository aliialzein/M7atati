import { useState } from "react";
import { branchPath } from "../../app/access.js";
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
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { BranchWorkspace } from "../../features/stations/BranchWorkspace.jsx";

function StationAnalytics({ station, user }) {
  const [filters, setFilters] = useState({ from: "", to: "" });
  const invalid = filters.from && filters.to && filters.from >= filters.to;
  const result = useResource(
    invalid
      ? null
      : query(`${branchPath(user, station.id)}/analytics`, {
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
  const { user } = useAuth();
  return (
    <BranchWorkspace title="Analytics" returnTo="/reports">
      {(station) => (
        <StationAnalytics key={station.id} station={station} user={user} />
      )}
    </BranchWorkspace>
  );
}
