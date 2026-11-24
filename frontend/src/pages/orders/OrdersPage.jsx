import { useState } from "react";
import { branchPath } from "../../app/access.js";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { BranchWorkspace } from "../../features/stations/BranchWorkspace.jsx";
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

const statuses = [
  "AWAITING_PAYMENT",
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

function BranchOrders({ user, station }) {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: "", from: "", to: "" });
  const invalid = filters.from && filters.to && filters.from >= filters.to;
  const result = useResource(
    invalid
      ? null
      : query(`${branchPath(user, station.id)}/orders`, {
          page,
          status: filters.status,
          from: iso(filters.from),
          to: iso(filters.to),
        }),
  );
  function update(key, value) {
    setPage(1);
    setFilters((state) => ({ ...state, [key]: value }));
  }
  return (
    <>
      <Title title="Branch orders" description={station.name} />
      <Card title="Order history">
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
          <DateFields {...filters} onChange={update} />
        </div>
        {invalid && (
          <p className="notice error" role="alert">
            The end date must be after the start date.
          </p>
        )}
        <Resource result={result}>
          {({ orders, pagination }) => (
            <>
              <Table
                columns={[
                  "Order",
                  "Fuel",
                  "Quantity",
                  "Amount",
                  "Status",
                  "Created",
                ]}
                rows={orders.map((row) => ({
                  id: row.id,
                  cells: [
                    <Button
                      to={query(`/orders/${row.id}`, {
                        branch: user.role === "ADMIN" ? station.id : null,
                      })}
                    >
                      #{row.id}
                    </Button>,
                    row.fuelType.name,
                    `${row.orderedVolume} L`,
                    money(row.orderedAmountMinor, row.currency),
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
  return (
    <BranchWorkspace title="Orders" returnTo="/orders">
      {(station) => (
        <BranchOrders key={station.id} user={user} station={station} />
      )}
    </BranchWorkspace>
  );
}
