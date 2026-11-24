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
import { humanize } from "../../lib/format.js";
import {
  AccountForm,
  UserManagement,
} from "../../features/people/UserManagement.jsx";

export default function PeoplePage() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const result = useResource(query("/users", { search, page }));
  const detail = useResource(selected ? `/users/${selected}` : null);
  const stationOptions = useResource(
    user.role === "MANAGER" ? "/stations/managed" : "/stations/picker",
    { publicRead: user.role !== "MANAGER" },
  );
  const stations = (stationOptions.data?.stations || []).filter(
    (station) => station.isActive !== false,
  );
  function refresh() {
    result.reload();
    if (selected) detail.reload();
  }
  return (
    <>
      <Title
        title="People"
        description="Staff accounts and station assignments."
      />
      <Card title="People directory">
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSearch(text.trim());
          }}
        >
          <Field label="Name or email">
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
          {({ users, pagination }) => (
            <>
              <Table
                columns={["Name", "Email", "Role", "Station", "Status"]}
                rows={users.map((person) => ({
                  id: person.id,
                  cells: [
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setSelected(person.id)}
                    >
                      {person.name}
                    </button>,
                    person.email,
                    humanize(person.role),
                    person.stationId ?? "—",
                    <Badge tone={person.isActive ? "green" : ""}>
                      {person.isActive ? "Active" : "Inactive"}
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
          {({ user: person }) => (
            <>
              <Card
                title="Selected account"
                action={
                  <Button onClick={() => setSelected(null)}>
                    Clear selection
                  </Button>
                }
              >
                <p>
                  {person.name} · {person.email} · {humanize(person.role)}
                </p>
              </Card>
              <UserManagement
                actor={user}
                person={person}
                stations={stations}
                refresh={refresh}
              />
            </>
          )}
        </Resource>
      )}
      {has(user, "users.create") && (
        <Resource result={stationOptions}>
          {() => (
            <AccountForm actor={user} stations={stations} refresh={refresh} />
          )}
        </Resource>
      )}
    </>
  );
}
