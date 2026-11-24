import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { Card, Title } from "../../components/ui.jsx";
import { humanize } from "../../lib/format.js";

export default function ProfilePage() {
  const { user } = useAuth();
  return (
    <>
      <Title
        title="My profile"
        description="Account information from the server."
      />
      <Card title="Account details">
        <dl className="details">
          <div>
            <dt>Full name</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{humanize(user.role)}</dd>
          </div>
          <div>
            <dt>Station affiliation</dt>
            <dd>
              {user.stationId ? `Station #${user.stationId}` : "Unassigned"}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
