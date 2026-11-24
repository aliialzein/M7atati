import { useParams } from "react-router-dom";
import { branchPath, has } from "../../app/access.js";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { BranchWorkspace } from "../../features/stations/BranchWorkspace.jsx";
import { CashConfirmation } from "../../features/orders/CashConfirmation.jsx";
import {
  Badge,
  Button,
  Card,
  Resource,
  Table,
  Title,
} from "../../components/ui.jsx";
import { dateTime, humanize, money } from "../../lib/format.js";

function OrderDetail({ user, station, id }) {
  const url = `${branchPath(user, station.id)}/orders/${id}`;
  const valid = /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= 2147483647;
  const result = useResource(valid ? url : null);
  return (
    <>
      <Title title={`Order #${id}`} description={station.name}>
        <Button
          to={query("/orders", {
            branch: user.role === "ADMIN" ? station.id : null,
          })}
        >
          ← Branch orders
        </Button>
      </Title>
      {!valid && (
        <p className="notice error" role="alert">
          Invalid order number.
        </p>
      )}
      <Resource result={result}>
        {({ order }) => {
          const canConfirmCash =
            user.role === "MANAGER" &&
            has(user, "payments.manage") &&
            station.isActive &&
            order.status === "AWAITING_PAYMENT" &&
            order.currency &&
            order.orderedAmountMinor > 0;
          return (
            <>
              <Card
                title="Order details"
                action={<Badge tone="green">{humanize(order.status)}</Badge>}
              >
                <dl className="details">
                  <div>
                    <dt>Fuel</dt>
                    <dd>{order.fuelType.name}</dd>
                  </div>
                  <div>
                    <dt>Quantity</dt>
                    <dd>{order.orderedVolume} L</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>{money(order.orderedAmountMinor, order.currency)}</dd>
                  </div>
                  <div>
                    <dt>Pump</dt>
                    <dd>{order.pump?.number ?? "Unassigned"}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{dateTime(order.createdAt)}</dd>
                  </div>
                </dl>
                <Button onClick={result.reload}>Refresh order</Button>
              </Card>
              {canConfirmCash && (
                <CashConfirmation
                  stationId={station.id}
                  url={url}
                  order={order}
                  update={result.reload}
                />
              )}
              <Card title="Order activity">
                <Table
                  columns={["Status", "Time"]}
                  rows={order.events.map((event) => ({
                    id: event.id,
                    cells: [
                      humanize(event.toStatus),
                      dateTime(event.createdAt),
                    ],
                  }))}
                  empty="No status changes yet."
                />
              </Card>
            </>
          );
        }}
      </Resource>
    </>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  return (
    <BranchWorkspace title={`Order #${id}`} returnTo="/orders">
      {(station) => (
        <OrderDetail
          key={`${station.id}:${id}`}
          user={user}
          station={station}
          id={id}
        />
      )}
    </BranchWorkspace>
  );
}
