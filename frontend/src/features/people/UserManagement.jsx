import { useState } from "react";
import { api } from "../../api/client.js";
import { useAction } from "../../api/hooks.js";
import { has } from "../../app/access.js";
import { Badge, Button, Card, Field, Status } from "../../components/ui.jsx";
import { humanize } from "../../lib/format.js";

const staffRoles = ["ADMIN", "MANAGER", "EMPLOYEE", "HR", "SECURITY"];
const needsStation = (role) => ["EMPLOYEE", "SECURITY"].includes(role);
const canHaveStation = (role) => role === "MANAGER" || needsStation(role);

export function AccountForm({ actor, person, stations, refresh }) {
  const editing = !!person;
  const roles = actor.role === "ADMIN" ? staffRoles : ["EMPLOYEE"];
  const [role, setRole] = useState(person?.role || roles[0]);
  const [stationId, setStationId] = useState(person?.stationId ?? "");
  const action = useAction();
  const customer = person?.role === "CUSTOMER";
  return (
    <Card title={editing ? `Edit ${person.name}` : "Create staff account"}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const form = Object.fromEntries(new FormData(formElement));
          const assignment =
            canHaveStation(role) && stationId ? Number(stationId) : null;
          const body = editing
            ? { name: form.name }
            : {
                name: form.name,
                email: form.email,
                password: form.password,
                role,
                stationId: assignment,
              };
          if (editing && !customer) {
            if (role !== person.role) body.role = role;
            if (assignment !== person.stationId) body.stationId = assignment;
          }
          action.run(
            async () => {
              await api(editing ? `/users/${person.id}` : "/users", {
                method: editing ? "PATCH" : "POST",
                body,
              });
              if (!editing) formElement.reset();
              refresh();
            },
            editing ? "Account updated." : "Staff account created.",
          );
        }}
      >
        <Field label="Full name">
          <input
            name="name"
            autoComplete="off"
            defaultValue={person?.name}
            required
            maxLength={128}
          />
        </Field>
        {!editing && (
          <>
            <Field label="Work email">
              <input
                name="email"
                type="email"
                autoComplete="off"
                required
                maxLength={254}
              />
            </Field>
            <Field
              label="Initial password"
              help="12 or more characters, including upper and lower case, a number, and a symbol."
            >
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={72}
              />
            </Field>
          </>
        )}
        {!customer && (
          <Field label="Role">
            <select
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
                if (!canHaveStation(event.target.value)) setStationId("");
              }}
            >
              {roles.map((value) => (
                <option value={value} key={value}>
                  {humanize(value)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!customer && canHaveStation(role) && (
          <Field label="Station">
            <select
              value={stationId}
              required={needsStation(role)}
              onChange={(event) => setStationId(event.target.value)}
            >
              <option value="">
                {needsStation(role) ? "Select a station" : "Unassigned"}
              </option>
              {person?.stationId &&
                !stations.some(
                  (station) => station.id === person.stationId,
                ) && (
                  <option value={person.stationId}>
                    Current station #{person.stationId}
                  </option>
                )}
              {stations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="actions">
          <Button primary type="submit" disabled={action.pending}>
            {editing ? "Save changes" : "Create account"}
          </Button>
        </div>
      </form>
      <Status action={action} />
    </Card>
  );
}

export function UserManagement({ actor, person, stations, refresh }) {
  const action = useAction();
  const [stationId, setStationId] = useState("");
  const edit =
    ["ADMIN", "MANAGER"].includes(actor.role) && has(actor, "users.update");
  const transfer =
    ["ADMIN", "HR"].includes(actor.role) &&
    has(actor, "employees.transfer") &&
    person.role === "EMPLOYEE";
  return (
    <>
      {edit && (
        <AccountForm
          key={`${person.id}-${person.updatedAt}`}
          actor={actor}
          person={person}
          stations={stations}
          refresh={refresh}
        />
      )}
      {(edit || transfer) && (
        <Card
          title={`Manage ${person.name}`}
          action={
            <Badge tone={person.isActive ? "green" : ""}>
              {person.isActive ? "Active" : "Inactive"}
            </Badge>
          }
        >
          {transfer && (
            <form
              className="filters"
              onSubmit={(event) => {
                event.preventDefault();
                action.run(async () => {
                  await api(`/users/${person.id}/transfer`, {
                    method: "POST",
                    body: { stationId: Number(stationId) },
                  });
                  setStationId("");
                  refresh();
                }, "Employee transferred.");
              }}
            >
              <Field label="Destination station">
                <select
                  required
                  value={stationId}
                  onChange={(event) => setStationId(event.target.value)}
                >
                  <option value="">Select a station</option>
                  {stations
                    .filter(({ id }) => id !== person.stationId)
                    .map((station) => (
                      <option key={station.id} value={station.id}>
                        {station.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Button type="submit" disabled={action.pending || !stationId}>
                Transfer employee
              </Button>
            </form>
          )}
          {edit && person.id !== actor.id && (
            <Button
              disabled={action.pending}
              onClick={() =>
                action.run(
                  async () => {
                    await api(`/users/${person.id}/status`, {
                      method: "PATCH",
                      body: { isActive: !person.isActive },
                    });
                    refresh();
                  },
                  person.isActive
                    ? "Account deactivated."
                    : "Account activated.",
                )
              }
            >
              {person.isActive ? "Deactivate account" : "Activate account"}
            </Button>
          )}
          <Status action={action} />
        </Card>
      )}
    </>
  );
}
