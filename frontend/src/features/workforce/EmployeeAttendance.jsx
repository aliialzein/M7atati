import { useRef } from "react";
import { api } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  Resource,
  Status,
  Title,
} from "../../components/ui.jsx";
import { dateTime, humanize } from "../../lib/format.js";

export function EmployeeAttendance({ user }) {
  const current = useResource("/employee/attendance/current");
  const action = useAction();
  const requestId = useRef(null);
  return (
    <>
      <Title
        title="My attendance"
        description="Record your arrival and departure."
      />
      <Status action={action} />
      <Resource result={current}>
        {({ state, openRecord, assignedStation, canCheckIn, canCheckOut }) => (
          <Card
            title={
              assignedStation?.name ||
              openRecord?.station?.name ||
              "No assigned station"
            }
            action={
              <Badge tone={openRecord ? "green" : ""}>{humanize(state)}</Badge>
            }
          >
            {openRecord && (
              <p>
                Clocked in at {dateTime(openRecord.clockInAt)} at{" "}
                {openRecord.station.name}.
              </p>
            )}
            {has(user, "attendance.self.write") && (
              <div className="actions">
                {canCheckIn && (
                  <Button
                    primary
                    disabled={action.pending}
                    onClick={() =>
                      action.run(async () => {
                        requestId.current ??= crypto.randomUUID();
                        await api("/employee/attendance/check-in", {
                          method: "POST",
                          body: { requestId: requestId.current },
                        });
                        requestId.current = null;
                        current.reload();
                      }, "Checked in.")
                    }
                  >
                    Check in
                  </Button>
                )}
                {canCheckOut && (
                  <Button
                    primary
                    disabled={action.pending}
                    onClick={() =>
                      action.run(async () => {
                        await api(
                          `/employee/attendance/${openRecord.id}/check-out`,
                          { method: "POST" },
                        );
                        requestId.current = null;
                        current.reload();
                      }, "Checked out.")
                    }
                  >
                    Check out
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}
      </Resource>
    </>
  );
}
