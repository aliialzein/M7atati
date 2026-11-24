import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { dashboardRole, features, has } from "../../app/access.js";
import { Badge, Button, Card, Title } from "../../components/ui.jsx";
import { query } from "../../api/client.js";
import { BranchDirectory } from "../../features/stations/BranchWorkspace.jsx";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";

export default function HomePage() {
  const { user } = useAuth();
  const visible = features.filter((feature) => feature.show(user));
  const executive = user.role === "ADMIN";
  const canOpenOrders = visible.some(({ path }) => path === "/orders");
  const canOpenAnalytics = visible.some(({ path }) => path === "/reports");
  return (
    <>
      <Title
        title={executive ? "Branch overview" : "My branch"}
        description={`Welcome, ${user.name}`}
      >
        <Badge tone="green">{dashboardRole(user)}</Badge>
      </Title>
      {executive ? (
        has(user, "stations.read") && (
          <BranchDirectory
            actions={(station) => (
              <>
                <Button to={query("/stations", { branch: station.id })}>
                  Details
                </Button>
                {canOpenOrders && (
                  <Button to={query("/orders", { branch: station.id })}>
                    Orders
                  </Button>
                )}
                {canOpenAnalytics && (
                  <Button to={query("/reports", { branch: station.id })}>
                    Analytics
                  </Button>
                )}
              </>
            )}
          />
        )
      ) : (
        <ManagedStation>
          {(station) => (
            <Card
              title={station.name}
              description="Your assigned branch"
              action={
                <Badge tone={station.isActive ? "green" : ""}>
                  {station.isActive ? "Active" : "Inactive"}
                </Badge>
              }
            >
              {visible.some(({ path }) => path === "/stations") && (
                <Button to="/stations">View branch and pumps</Button>
              )}
            </Card>
          )}
        </ManagedStation>
      )}
      <div className="card-grid">
        {visible.map(({ path, label, text }) => (
          <Card title={label} description={text} key={path}>
            <Button to={path}>Open {label.toLowerCase()} →</Button>
          </Card>
        ))}
      </div>
    </>
  );
}
