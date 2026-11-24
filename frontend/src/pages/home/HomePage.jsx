import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { features } from "../../app/access.js";
import { Badge, Button, Card, Title } from "../../components/ui.jsx";
import { humanize } from "../../lib/format.js";

export default function HomePage() {
  const { user } = useAuth();
  const visible = features.filter((feature) => feature.show(user));
  return (
    <>
      <Title
        title={`Welcome, ${user.name}`}
        description="SmartStation operations"
      >
        <Badge tone="green">{humanize(user.role)}</Badge>
      </Title>
      <div className="card-grid">
        {visible.map(({ path, label, text }) => (
          <Card title={label} description={text} key={path}>
            <Button to={path}>Open {label.toLowerCase()} →</Button>
          </Card>
        ))}
      </div>
      {!visible.length && (
        <Card title="Your account">
          <p className="muted">
            No operational areas are available for your account.
          </p>
          <Button to="/profile">View profile</Button>
        </Card>
      )}
    </>
  );
}
