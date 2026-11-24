import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { Card, Title } from "../../components/ui.jsx";
import { dashboardRole } from "../../app/access.js";

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
            <dd>{dashboardRole(user)}</dd>
          </div>
          <div>
            <dt>Branch access</dt>
            <dd>
              {user.role === "ADMIN" ? "All branches" : "Your assigned branch"}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
