import { useState } from "react";
import { api, query } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import {
  Button,
  Card,
  Field,
  Pagination,
  Resource,
  Status,
  Table,
} from "../../components/ui.jsx";
import { dateTime, iso } from "../../lib/format.js";

export function SellingPrices({ fuelTypes, editable }) {
  const [fuel, setFuel] = useState("");
  const [currency, setCurrency] = useState("");
  const [page, setPage] = useState(1);
  const history = useResource(
    query("/fuel-prices/selling", { page, fuelTypeId: fuel, currency }),
  );
  const action = useAction();
  const nameFor = (id) =>
    fuelTypes.find((item) => item.id === id)?.name ?? `Fuel #${id}`;
  return (
    <>
      <Card
        title="Selling tariffs"
        description="Global prices used by the checkout quote API."
      >
        <div className="filters">
          <Field label="Fuel">
            <select
              value={fuel}
              onChange={(event) => {
                setFuel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All fuels</option>
              {fuelTypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All currencies</option>
              <option>USD</option>
              <option>LBP</option>
            </select>
          </Field>
        </div>
        <Resource result={history}>
          {({ prices, pagination }) => (
            <>
              <Table
                columns={["Fuel", "Price per liter", "Effective date"]}
                rows={prices.map((price) => ({
                  id: price.id,
                  cells: [
                    nameFor(price.fuelTypeId),
                    `${price.unitPrice} ${price.currency}`,
                    dateTime(price.effectiveAt),
                  ],
                }))}
                empty="No selling tariffs match this view."
              />
              <Pagination data={pagination} page={page} setPage={setPage} />
            </>
          )}
        </Resource>
      </Card>
      {editable && !!fuelTypes.length && (
        <Card title="Publish selling tariff">
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const element = event.currentTarget;
              const form = Object.fromEntries(new FormData(element));
              action.run(async () => {
                await api("/fuel-prices/selling", {
                  method: "POST",
                  body: {
                    fuelTypeId: Number(form.fuelTypeId),
                    currency: form.currency,
                    unitPrice: form.unitPrice.trim(),
                    effectiveAt: iso(form.effectiveAt),
                  },
                });
                element.reset();
                history.reload();
              }, "Selling tariff published.");
            }}
          >
            <Field label="Fuel type">
              <select name="fuelTypeId" required defaultValue="">
                <option value="">Select fuel</option>
                {fuelTypes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
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
            <Field label="Unit price per liter">
              <input
                name="unitPrice"
                inputMode="decimal"
                pattern="[0-9]+([.][0-9]+)?"
                maxLength={20}
                required
              />
            </Field>
            <Field label="Effective date and time">
              <input name="effectiveAt" type="datetime-local" required />
            </Field>
            <div className="actions">
              <Button type="submit" primary disabled={action.pending}>
                Publish price
              </Button>
            </div>
          </form>
          <Status action={action} />
        </Card>
      )}
    </>
  );
}
