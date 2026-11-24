import { useState } from "react";
import { api } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { Button, Card, Field, Resource, Status } from "../../components/ui.jsx";
import { money } from "../../lib/format.js";

export function CashConfirmation({ stationId, url, order, update }) {
  const [pumpId, setPumpId] = useState("");
  const pumps = useResource(`/stations/${stationId}/pumps`);
  const action = useAction();
  return (
    <Card
      title="Confirm cash payment"
      description="Confirm after receiving the cash and choose an available pump."
    >
      <Resource result={pumps}>
        {({ pumps: list }) => {
          const available = list.filter((pump) => pump.available);
          return available.length ? (
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                action.run(async () => {
                  await api(`${url}/confirm-cash`, {
                    method: "POST",
                    body: {
                      amountMinor: order.orderedAmountMinor,
                      currency: order.currency,
                      pumpId: Number(pumpId),
                    },
                  });
                  update();
                });
              }}
            >
              <Field label="Amount due">
                <output>
                  {money(order.orderedAmountMinor, order.currency)}
                </output>
              </Field>
              <Field label="Pump">
                <select
                  value={pumpId}
                  onChange={(event) => setPumpId(event.target.value)}
                  required
                >
                  <option value="">Choose a pump</option>
                  {available.map((pump) => (
                    <option value={pump.id} key={pump.id}>
                      Pump {pump.number}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="actions">
                <Button
                  primary
                  type="submit"
                  disabled={
                    action.pending ||
                    !available.some((pump) => String(pump.id) === pumpId)
                  }
                >
                  Confirm cash
                </Button>
                <Button onClick={pumps.reload} disabled={action.pending}>
                  Refresh pumps
                </Button>
              </div>
            </form>
          ) : (
            <div className="actions">
              <p className="empty">No pumps are currently available.</p>
              <Button onClick={pumps.reload}>Refresh pumps</Button>
            </div>
          );
        }}
      </Resource>
      <Status action={action} />
    </Card>
  );
}
