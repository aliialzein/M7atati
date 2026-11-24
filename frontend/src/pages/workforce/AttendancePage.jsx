import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { WorkRecords } from "../../features/workforce/WorkRecords.jsx";
import { ManagedStation } from "../../features/stations/ManagedStation.jsx";

export default function AttendancePage() {
  const { user } = useAuth();
  if (user.role === "MANAGER")
    return (
      <ManagedStation>
        {(station) => <WorkRecords kind="attendance" station={station} />}
      </ManagedStation>
    );
  return <WorkRecords kind="attendance" />;
}
