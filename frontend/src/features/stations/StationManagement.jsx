import { useState } from "react";
import { api } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  Field,
  Resource,
  Status,
  Table,
} from "../../components/ui.jsx";
import { humanize } from "../../lib/format.js";

export function Pumps({ station }) {
  const result = useResource(
    station.isActive ? `/stations/${station.id}/pumps` : null,
  );
  return (
    <Card
      title="Station pumps"
      action={
        station.isActive && <Button onClick={result.reload}>Refresh</Button>
      }
    >
      {station.isActive ? (
        <Resource result={result}>
          {({ pumps }) => (
            <Table
              columns={["Pump", "Status", "Availability"]}
              rows={pumps.map((pump) => ({
                id: pump.id,
                cells: [
                  pump.number,
                  humanize(pump.status),
                  <Badge tone={pump.available ? "green" : ""}>
                    {pump.available ? "Available" : "Unavailable"}
                  </Badge>,
                ],
              }))}
              empty="No pumps are registered for this station."
            />
          )}
        </Resource>
      ) : (
        <p className="empty">The station is inactive.</p>
      )}
    </Card>
  );
}

export function StationForm({ station, refresh }) {
  const action = useAction();
  return (
    <Card title={station ? "Edit station" : "Create station"}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const formElement = event.currentTarget;
          const { name, address, latitude, longitude } = Object.fromEntries(
            new FormData(formElement),
          );
          action.run(
            async () => {
              if (!!latitude !== !!longitude)
                throw new Error("Enter both coordinates or leave both blank.");
              await api(station ? `/stations/${station.id}` : "/stations", {
                method: station ? "PATCH" : "POST",
                body: {
                  name,
                  address,
                  latitude: latitude === "" ? null : Number(latitude),
                  longitude: longitude === "" ? null : Number(longitude),
                },
              });
              if (!station) formElement.reset();
              refresh();
            },
            station ? "Station updated." : "Station created.",
          );
        }}
      >
        <Field label="Station name">
          <input
            name="name"
            defaultValue={station?.name}
            required
            maxLength={128}
          />
        </Field>
        <Field label="Address">
          <input
            name="address"
            defaultValue={station?.address ?? ""}
            required
            maxLength={512}
          />
        </Field>
        <Field label="Latitude">
          <input
            name="latitude"
            type="number"
            step="any"
            min="-90"
            max="90"
            defaultValue={station?.latitude ?? ""}
          />
        </Field>
        <Field label="Longitude">
          <input
            name="longitude"
            type="number"
            step="any"
            min="-180"
            max="180"
            defaultValue={station?.longitude ?? ""}
          />
        </Field>
        <div className="actions">
          <Button primary type="submit" disabled={action.pending}>
            {station ? "Save station" : "Create station"}
          </Button>
        </div>
      </form>
      <Status action={action} />
    </Card>
  );
}

export function StationAdmin({ station, refresh, user }) {
  const action = useAction();
  const canList = has(user, "users.read");
  const managers = useResource(
    canList ? "/users?role=MANAGER&isActive=true&limit=100" : null,
  );
  const [managerId, setManagerId] = useState(station.managerId ?? "");
  return (
    <>
      <StationForm station={station} refresh={refresh} />
      <Card
        title="Station administration"
        action={
          <Badge tone={station.isActive ? "green" : ""}>
            {station.isActive ? "Active" : "Inactive"}
          </Badge>
        }
      >
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            action.run(async () => {
              await api(`/stations/${station.id}/manager`, {
                method: "PATCH",
                body: {
                  managerId: managerId === "" ? null : Number(managerId),
                },
              });
              refresh();
            }, "Manager assignment saved.");
          }}
        >
          <Field label="Manager ID" help="Leave blank to unassign the manager.">
            <input
              type="number"
              min="1"
              max="2147483647"
              step="1"
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
              list={canList ? "managers" : undefined}
            />
          </Field>
          {canList && (
            <datalist id="managers">
              {managers.data?.users.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.name}
                </option>
              ))}
            </datalist>
          )}
          <Button type="submit" disabled={action.pending}>
            Save manager assignment
          </Button>
        </form>
        <Button
          disabled={action.pending}
          onClick={() =>
            action.run(
              async () => {
                await api(`/stations/${station.id}/status`, {
                  method: "PATCH",
                  body: { isActive: !station.isActive },
                });
                refresh();
              },
              station.isActive ? "Station deactivated." : "Station activated.",
            )
          }
        >
          {station.isActive ? "Deactivate station" : "Activate station"}
        </Button>
        <Status action={action} />
      </Card>
    </>
  );
}
