import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { WorkRecords } from "../../features/workforce/WorkRecords.jsx";

export default function ShiftsPage() {
  const { user } = useAuth();
  return <WorkRecords kind="shifts" employee={user.role === "EMPLOYEE"} />;
}
