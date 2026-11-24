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

export function WorkRecords({ kind, station, employee = false }) {
  const isShift = kind === "shifts";
  const [filters, setFilters] = useState({
    from: "",
    to: "",
    employeeId: "",
    stationId: "",
  });
  const weekNow = beirutMonday();
  const [week, setWeek] = useState(weekNow);
  const [page, setPage] = useState(1);
  const action = useAction();
  const invalid =
    !employee && filters.from && filters.to && filters.from >= filters.to;
  const monday = week && new Date(`${week}T00:00:00Z`).getUTCDay() === 1;
  const path = employee
    ? "/employee/shifts"
    : station
      ? `/manager/stations/${station.id}/attendance`
      : `/${kind}`;
  const search = employee
    ? { weekStart: week }
    : {
        from: iso(filters.from),
        to: iso(filters.to),
        employeeId: filters.employeeId,
        ...(station ? {} : { stationId: filters.stationId }),
      };
  const records = useResource(
    !invalid && (!employee || monday) ? query(path, { ...search, page }) : null,
  );
  function change(key, value) {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  }
  function changeWeek(value) {
    setWeek(value);
    setPage(1);
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
        title={employee ? "My shifts" : isShift ? "Shifts" : "Attendance"}
        description={
          station?.name ||
          (employee
            ? "Schedule in the Asia/Beirut time zone."
            : "Browse work records and filter by date or assignment.")
        }
      />
      <Card title={isShift ? "Shift records" : "Attendance records"}>
        {employee ? (
          <div className="filters">
            <Field label="Week beginning (Monday)">
              <input
                type="date"
                value={week}
                onChange={(event) => changeWeek(event.target.value)}
              />
            </Field>
            <Button
              disabled={!monday}
              onClick={() => changeWeek(offsetWeek(week, -7))}
            >
              Previous week
            </Button>
            <Button onClick={() => changeWeek(weekNow)}>This week</Button>
            <Button
              disabled={!monday}
              onClick={() => changeWeek(offsetWeek(week, 7))}
            >
              Next week
            </Button>
          </div>
        ) : (
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
        )}
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
        {employee && !monday && (
          <p className="notice error" role="alert">
            Choose a Monday.
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

function offsetWeek(week, offset) {
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function beirutMonday() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Beirut",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts()
      .map(({ type, value }) => [type, value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return offsetWeek(
    today,
    -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7),
  );
}
