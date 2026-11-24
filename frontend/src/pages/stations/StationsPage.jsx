import { useState } from "react";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  Field,
  Pagination,
  Resource,
  Table,
  Title,
} from "../../components/ui.jsx";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";
import {
  Pumps,
  StationAdmin,
  StationForm,
} from "../../features/stations/StationManagement.jsx";

function AdminStations({ user }) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const result = useResource(query("/stations", { search, page }));
  const detail = useResource(selected ? `/stations/${selected}` : null);
  function refresh() {
    result.reload();
    if (selected) detail.reload();
  }
  return (
    <>
      <Title
        title="Stations"
        description="Station details, assignments, and pump availability."
      />
      <Card title="Station directory">
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(text.trim());
          }}
        >
          <Field label="Name or address">
            <input
              type="search"
              value={text}
              maxLength={128}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Button type="submit">Search</Button>
        </form>
        <Resource result={result}>
          {({ stations, pagination }) => (
            <>
              <Table
                columns={["Station", "Address", "Manager ID", "Status"]}
                rows={stations.map((station) => ({
                  id: station.id,
                  cells: [
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setSelected(station.id)}
                    >
                      {station.name}
                    </button>,
                    station.address ?? "—",
                    station.managerId ?? "—",
                    <Badge tone={station.isActive ? "green" : ""}>
                      {station.isActive ? "Active" : "Inactive"}
                    </Badge>,
                  ],
                }))}
              />
              <Pagination data={pagination} page={page} setPage={setPage} />
            </>
          )}
        </Resource>
      </Card>
      {selected && (
        <Resource result={detail}>
          {({ station }) => (
            <>
              <Card
                title={station.name}
                action={
                  <Button onClick={() => setSelected(null)}>
                    Clear selection
                  </Button>
                }
              >
                <p>{station.address}</p>
              </Card>
              <Pumps station={station} />
              {has(user, "stations.update") && (
                <StationAdmin
                  key={station.id}
                  station={station}
                  refresh={refresh}
                  user={user}
                />
              )}
            </>
          )}
        </Resource>
      )}
      {has(user, "stations.create") && <StationForm refresh={refresh} />}
    </>
  );
}

export default function StationsPage() {
  const { user } = useAuth();
  return user.role === "MANAGER" ? (
    <ManagedStation>
      {(station) => (
        <>
          <Title
            title={station.name}
            description="Station and pump availability."
          />
          <Pumps station={station} />
        </>
      )}
    </ManagedStation>
  ) : (
    <AdminStations user={user} />
  );
}
