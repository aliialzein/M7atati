import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import {
  Button,
  Card,
  Field,
  Resource,
  Status,
  Title,
} from "../../components/ui.jsx";
import { dateTime } from "../../lib/format.js";
import { rememberGuestOrder } from "../../features/orders/guestOrders.js";

export default function CheckoutPage() {
  const { user } = useAuth();
  const stations = useResource("/stations/picker", { publicRead: true });
  const fuels = useResource("/fuel-types", { publicRead: true });
  const action = useAction();
  const [price, setPrice] = useState(null);
  const navigate = useNavigate();
  function getQuote(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    action.run(async () => {
      const result = await api("/orders/quotes", {
        method: "POST",
        public: !user,
        ensureSession: !!user,
        body: {
          ...form,
          value: form.value.trim(),
          stationId: Number(form.stationId),
          fuelTypeId: Number(form.fuelTypeId),
        },
      });
      setPrice({ ...result, key: crypto.randomUUID() });
    });
  }
  function placeOrder() {
    action.run(async () => {
      const { order, guestAccessToken } = await api("/orders", {
        method: "POST",
        public: !user,
        ensureSession: !!user,
        body: {
          quoteId: price.quote.id,
          idempotencyKey: price.key,
          guestToken: price.guestToken,
        },
      });
      if (guestAccessToken) rememberGuestOrder(order.id, guestAccessToken);
      navigate(`/orders/${order.id}`, { replace: true });
    });
  }
  return (
    <>
      <Title
        title="Order fuel"
        description="Get a quote, place your order, and pay at the station."
      />
      <Resource result={stations}>
        {({ stations }) => (
          <Resource result={fuels}>
            {({ fuelTypes }) => (
              <div className="detail-grid">
                <Card title="Fuel selection">
                  {stations.length && fuelTypes.length ? (
                    <form
                      onSubmit={getQuote}
                      onChange={() => {
                        setPrice(null);
                        action.clear();
                      }}
                    >
                      <fieldset className="form-grid" disabled={action.pending}>
                        <Field label="Station">
                          <select name="stationId" required defaultValue="">
                            <option value="">Select a station</option>
                            {stations.map((station) => (
                              <option key={station.id} value={station.id}>
                                {station.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Fuel type">
                          <select name="fuelTypeId" required defaultValue="">
                            <option value="">Select fuel</option>
                            {fuelTypes.map((fuel) => (
                              <option key={fuel.id} value={fuel.id}>
                                {fuel.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Currency">
                          <select name="currency">
                            <option>USD</option>
                            <option>LBP</option>
                          </select>
                        </Field>
                        <Field label="Fulfillment">
                          <select name="fulfillmentType">
                            <option value="IN_STATION">In station</option>
                            {user && <option value="PICKUP">Pickup</option>}
                          </select>
                        </Field>
                        <Field label="Order by">
                          <select name="inputMode">
                            <option value="LITERS">Liters</option>
                            <option value="AMOUNT">
                              Amount in selected currency
                            </option>
                          </select>
                        </Field>
                        <Field label="Quantity or amount">
                          <input
                            name="value"
                            inputMode="decimal"
                            pattern="[0-9]+([.][0-9]+)?"
                            placeholder="e.g. 10"
                            maxLength={24}
                            required
                          />
                        </Field>
                        <div className="actions">
                          <Button
                            type="submit"
                            primary
                            disabled={action.pending}
                          >
                            Get quote
                          </Button>
                        </div>
                      </fieldset>
                    </form>
                  ) : (
                    <p className="empty">
                      An active station and a fuel type are required to place an
                      order.
                    </p>
                  )}
                </Card>
                <Card title="Order summary">
                  {price ? (
                    <>
                      <dl className="details">
                        <div>
                          <dt>Quantity</dt>
                          <dd>{price.quote.quantity} L</dd>
                        </div>
                        <div>
                          <dt>Unit price</dt>
                          <dd>
                            {price.quote.unitPrice} {price.quote.currency}
                          </dd>
                        </div>
                        <div>
                          <dt>Total</dt>
                          <dd>
                            {price.quote.total} {price.quote.currency}
                          </dd>
                        </div>
                        <div>
                          <dt>Quote expires</dt>
                          <dd>{dateTime(price.quote.expiresAt)}</dd>
                        </div>
                      </dl>
                      <Button
                        primary
                        disabled={action.pending}
                        onClick={placeOrder}
                      >
                        Place order
                      </Button>
                    </>
                  ) : (
                    <p className="empty">Your quote will appear here.</p>
                  )}
                  <Status action={action} />
                </Card>
              </div>
            )}
          </Resource>
        )}
      </Resource>
    </>
  );
}
