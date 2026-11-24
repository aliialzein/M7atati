import { useState } from "react";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  DateFields,
  Field,
  Pagination,
  Resource,
  Table,
  Title,
} from "../../components/ui.jsx";
import { dateTime, humanize, iso, money } from "../../lib/format.js";
import { orderPath } from "../../features/orders/orderPaths.js";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";

const statuses = [
  "AWAITING_PAYMENT",
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];
function List({ user, station }) {
  const { role } = user;
  const employee = role === "EMPLOYEE";
  const manager = role === "MANAGER";
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: "", from: "", to: "" });
  const invalid =
    manager && filters.from && filters.to && filters.from >= filters.to;
  const path =
    orderPath(role, station?.id) +
    (role === "CUSTOMER" || (employee && mine) ? "/mine" : "");
  const result = useResource(
    invalid
      ? null
      : query(path, {
          page,
          ...(employee ? {} : { status: filters.status }),
          ...(manager ? { from: iso(filters.from), to: iso(filters.to) } : {}),
        }),
  );
  function update(key, value) {
    setPage(1);
    setFilters((state) => ({ ...state, [key]: value }));
  }
  const columns = [
    "Order",
    "Fuel",
    "Quantity",
    ...(!employee ? ["Amount"] : []),
    "Status",
    "Created",
  ];
  return (
    <>
      <Title
        title={
          employee
            ? "Order workspace"
            : role === "CUSTOMER"
              ? "My orders"
              : "Station orders"
        }
        description={
          station?.name ||
          (employee
            ? "View pending work and orders assigned to you."
            : "Track your fuel orders.")
        }
      >
        {role === "CUSTOMER" && has(user, "orders.create") && (
          <Button to="/orders/new" primary>
            Order fuel
          </Button>
        )}
      </Title>
      <Card
        title={
          employee
            ? mine
              ? "Assigned to me"
              : "Pending orders"
            : "Order history"
        }
      >
        {employee ? (
          <div className="actions filters">
            <Button
              primary={!mine}
              aria-pressed={!mine}
              onClick={() => {
                setMine(false);
                setPage(1);
              }}
            >
              Pending queue
            </Button>
            <Button
              primary={mine}
              aria-pressed={mine}
              onClick={() => {
                setMine(true);
                setPage(1);
              }}
            >
              My assigned work
            </Button>
          </div>
        ) : (
          <div className="filters">
            <Field label="Status">
              <select
                value={filters.status}
                onChange={(event) => update("status", event.target.value)}
              >
                <option value="">All statuses</option>
                {statuses.map((status) => (
                  <option value={status} key={status}>
                    {humanize(status)}
                  </option>
                ))}
              </select>
            </Field>
            {manager && <DateFields {...filters} onChange={update} />}
          </div>
        )}
        {invalid && (
          <p className="notice error" role="alert">
            The end date must be after the start date.
          </p>
        )}
        <Resource result={result}>
          {({ orders, pagination }) => (
            <>
              <Table
                columns={columns}
                rows={orders.map((row) => ({
                  id: row.id,
                  cells: [
                    <Button to={`/orders/${row.id}`}>#{row.id}</Button>,
                    row.fuelType.name,
                    `${row.orderedVolume} L`,
                    ...(!employee
                      ? [money(row.orderedAmountMinor, row.currency)]
                      : []),
                    <Badge>{humanize(row.status)}</Badge>,
                    dateTime(row.createdAt),
                  ],
                }))}
                empty="No orders match this view."
              />
              <Pagination data={pagination} page={page} setPage={setPage} />
            </>
          )}
        </Resource>
      </Card>
    </>
  );
}

export default function OrdersPage() {
  const { user } = useAuth();
  return user.role === "MANAGER" ? (
    <ManagedStation>
      {(station) => <List user={user} station={station} />}
    </ManagedStation>
  ) : (
    <List user={user} />
  );
}
