import { useParams } from "react-router-dom";
import { api } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  Resource,
  Status,
  Table,
  Title,
} from "../../components/ui.jsx";
import { dateTime, humanize, money } from "../../lib/format.js";
import { CashConfirmation } from "../../features/orders/CashConfirmation.jsx";
import { guestOrderToken } from "../../features/orders/guestOrders.js";
import { orderPath } from "../../features/orders/orderPaths.js";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";

function Detail({ user, station, id }) {
  const role = user?.role;
  const guest = !user;
  const token = guest ? guestOrderToken(id) : undefined;
  const customer = !role || role === "CUSTOMER";
  const path = `${orderPath(role, station?.id)}/${id}`;
  const valid =
    /^[1-9][0-9]{0,9}$/.test(id) &&
    Number(id) <= 2147483647 &&
    (!guest || !!token);
  const action = useAction();
  const ensureSession = customer && !guest;
  const sessionOptions = {
    publicRead: guest,
    guestToken: token,
    ensureSession,
  };
  const record = useResource(valid ? path : null, sessionOptions);
  const history = useResource(
    customer && valid ? `${path}/events` : null,
    sessionOptions,
  );
  function update() {
    record.reload();
    if (customer) history.reload();
  }
  function transition(kind) {
    action.run(
      async () => {
        await api(`${path}/${kind}`, {
          method: "POST",
          guestToken: token,
          public: guest,
          ensureSession,
        });
        update();
      },
      kind === "cancel"
        ? "Order cancelled."
        : kind === "claim"
          ? "Order assigned to you."
          : "Order completed.",
    );
  }
  return (
    <>
      <Title title={`Order #${id}`} description={station?.name}>
        <Button to={guest ? "/orders/new" : "/orders"}>
          ← {guest ? "Place another order" : "Back to orders"}
        </Button>
      </Title>
      {!valid ? (
        <p className="notice error" role="alert">
          {guest
            ? "This guest order is only available from the browser tab that placed it."
            : "Invalid order number."}
        </p>
      ) : (
        <Resource result={record}>
          {({ order }) => {
            const cancel =
              customer &&
              (guest || has(user, "orders.cancel")) &&
              order.status === "AWAITING_PAYMENT" &&
              !order.pump;
            const claim =
              user?.role === "EMPLOYEE" &&
              has(user, "orders.update") &&
              order.status === "PENDING" &&
              !order.assignedEmployeeId;
            const complete =
              user?.role === "EMPLOYEE" &&
              has(user, "orders.update") &&
              order.status === "IN_PROGRESS" &&
              order.assignedEmployeeId === user.id;
            const cash =
              user?.role === "MANAGER" &&
              has(user, "payments.manage") &&
              station.isActive &&
              order.status === "AWAITING_PAYMENT" &&
              order.currency &&
              order.orderedAmountMinor > 0;
            const renderEvents = (items) => (
              <Table
                columns={["Status", "Time"]}
                rows={items.map((event) => ({
                  id: event.id,
                  cells: [humanize(event.toStatus), dateTime(event.createdAt)],
                }))}
                empty="No status changes yet."
              />
            );
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
                    {order.orderedAmountMinor != null && (
                      <div>
                        <dt>Amount</dt>
                        <dd>
                          {money(order.orderedAmountMinor, order.currency)}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Pump</dt>
                      <dd>{order.pump?.number ?? "Unassigned"}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{dateTime(order.createdAt)}</dd>
                    </div>
                    {order.station && (
                      <div>
                        <dt>Station</dt>
                        <dd>{order.station.name}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="actions">
                    {cancel && (
                      <Button
                        disabled={action.pending}
                        onClick={() => transition("cancel")}
                      >
                        Cancel unpaid order
                      </Button>
                    )}
                    {claim && (
                      <Button
                        primary
                        disabled={action.pending}
                        onClick={() => transition("claim")}
                      >
                        Claim order
                      </Button>
                    )}
                    {complete && (
                      <Button
                        primary
                        disabled={action.pending}
                        onClick={() => transition("complete")}
                      >
                        Complete order
                      </Button>
                    )}
                    <Button onClick={update}>Refresh order</Button>
                  </div>
                  <Status action={action} />
                </Card>
                {cash && (
                  <CashConfirmation
                    stationId={station.id}
                    url={path}
                    order={order}
                    update={update}
                  />
                )}
                <Card title="Order activity">
                  {customer ? (
                    <Resource result={history}>
                      {({ events }) => renderEvents(events)}
                    </Resource>
                  ) : (
                    renderEvents(order.events || [])
                  )}
                </Card>
              </>
            );
          }}
        </Resource>
      )}
    </>
  );
}

export default function OrderDetailPage() {
  const { user } = useAuth();
  const { id } = useParams();
  return user?.role === "MANAGER" ? (
    <ManagedStation>
      {(station) => <Detail key={id} user={user} station={station} id={id} />}
    </ManagedStation>
  ) : (
    <Detail key={id} user={user} id={id} />
  );
}
