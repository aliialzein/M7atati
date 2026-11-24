import { useState } from "react";
import { api, query } from "../../api/client.js";
import { useAction, useResource } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { has } from "../../app/access.js";
import {
  Badge,
  Button,
  Card,
  Pagination,
  Resource,
  Status,
  Table,
  Title,
} from "../../components/ui.jsx";
import { SellingPrices } from "../../features/pricing/SellingPrices.jsx";

export default function FuelPricesPage() {
  const { user } = useAuth();
  const editable = has(user, "pricing.update");
  const fuel = useResource("/fuel-types", { publicRead: true });
  const [history, setHistory] = useState(false);
  const [page, setPage] = useState(1);
  const reference = useResource(
    history ? query("/fuel-prices/history", { page }) : "/fuel-prices/current",
  );
  const action = useAction();
  return (
    <>
      <Title
        title="Fuel prices"
        description="Manage selling tariffs and view the market reference feed."
      />
      <Resource result={fuel}>
        {({ fuelTypes }) => (
          <SellingPrices fuelTypes={fuelTypes} editable={editable} />
        )}
      </Resource>
      <Card
        title="Reference prices"
        description="External market data, separate from checkout tariffs."
        action={
          editable && (
            <Button
              disabled={action.pending}
              onClick={() =>
                action.run(async () => {
                  await api("/fuel-prices/refresh", {
                    method: "POST",
                    body: {},
                  });
                  reference.reload();
                }, "Reference prices refreshed.")
              }
            >
              Refresh reference prices
            </Button>
          )
        }
      >
        <div className="actions filters">
          <Button
            primary={!history}
            aria-pressed={!history}
            onClick={() => {
              setHistory(false);
              setPage(1);
            }}
          >
            Current prices
          </Button>
          <Button
            primary={history}
            aria-pressed={history}
            onClick={() => {
              setHistory(true);
              setPage(1);
            }}
          >
            Price history
          </Button>
        </div>
        <Status action={action} />
        <Resource result={reference}>
          {({ prices, pagination }) => (
            <>
              <Table
                columns={[
                  "Fuel",
                  "Reference price",
                  "Effective date",
                  "Freshness",
                ]}
                rows={prices.map((price) => ({
                  id: price.id,
                  cells: [
                    price.fuelCode,
                    `${price.price ?? "—"} ${price.currency ?? ""} / ${price.unit ?? "—"}`,
                    price.effectiveAt ?? "—",
                    <Badge>
                      {price.stale ? "Stale" : (price.freshness ?? "—")}
                    </Badge>,
                  ],
                }))}
                empty="No reference prices are stored."
              />
              <Pagination data={pagination} page={page} setPage={setPage} />
            </>
          )}
        </Resource>
      </Card>
    </>
  );
}
