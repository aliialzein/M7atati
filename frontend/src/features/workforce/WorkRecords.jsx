import { useState } from "react";
import { api, query } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import {
  Badge,
  Button,
  Card,
  DateFields,
  Field,
  Pagination,
  Resource,
  Status,
  Table,
  Title,
} from "../../components/ui.jsx";
import { dateTime, iso } from "../../lib/format.js";
import { downloadFile } from "../../lib/download.js";

export function WorkRecords({ kind, station }) {
  const isShift = kind === "shifts";
  const [filters, setFilters] = useState({
    from: "",
    to: "",
    employeeId: "",
    stationId: "",
  });
  const [page, setPage] = useState(1);
  const action = useAction();
  const invalid = filters.from && filters.to && filters.from >= filters.to;
  const path = station
    ? `/manager/stations/${station.id}/attendance`
    : `/${kind}`;
  const search = {
    from: iso(filters.from),
    to: iso(filters.to),
    employeeId: filters.employeeId,
    ...(station ? {} : { stationId: filters.stationId }),
  };
  const records = useResource(
    invalid ? null : query(path, { ...search, page }),
  );
  function change(key, value) {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  }
  function exportRecords(format) {
    action.run(async () =>
      downloadFile(
        await api(query(`${path}/export`, { ...search, format }), {
          binary: true,
        }),
        `station-${station.id}-attendance.${format}`,
      ),
    );
  }
  return (
    <>
      <Title
        title={isShift ? "Shifts" : "Attendance"}
        description={
          station?.name ||
          "Browse work records and filter by date or assignment."
        }
      />
      <Card title={isShift ? "Shift records" : "Attendance records"}>
        <div className="filters">
          <DateFields {...filters} onChange={change} />
          <Field label="Employee ID">
            <input
              type="number"
              min="1"
              max="2147483647"
              step="1"
              value={filters.employeeId}
              onChange={(event) => change("employeeId", event.target.value)}
            />
          </Field>
          {!station && (
            <Field label="Station ID">
              <input
                type="number"
                min="1"
                max="2147483647"
                step="1"
                value={filters.stationId}
                onChange={(event) => change("stationId", event.target.value)}
              />
            </Field>
          )}
        </div>
        {station && (
          <div className="actions export-actions">
            <Button
              disabled={!!invalid || action.pending}
              onClick={() => exportRecords("csv")}
            >
              Export CSV
            </Button>
            <Button
              disabled={!!invalid || action.pending}
              onClick={() => exportRecords("pdf")}
            >
              Export PDF
            </Button>
          </div>
        )}
        <Status action={action} />
        {invalid && (
          <p className="notice error" role="alert">
            The end date must be after the start date.
          </p>
        )}
        <Resource result={records}>
          {(data) => (
            <>
              <Table
                columns={[
                  "Employee",
                  "Station",
                  isShift ? "Starts" : "Clock in",
                  isShift ? "Ends" : "Clock out",
                ]}
                rows={data[kind].map((row) => ({
                  id: row.id,
                  cells: [
                    row.employee.name,
                    row.station.name,
                    dateTime(isShift ? row.startsAt : row.clockInAt),
                    isShift || row.clockOutAt ? (
                      dateTime(isShift ? row.endsAt : row.clockOutAt)
                    ) : (
                      <Badge tone="green">Open</Badge>
                    ),
                  ],
                }))}
              />
              <Pagination
                data={data.pagination}
                page={page}
                setPage={setPage}
              />
            </>
          )}
        </Resource>
      </Card>
    </>
  );
}
