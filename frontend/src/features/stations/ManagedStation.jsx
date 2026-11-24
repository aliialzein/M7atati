import { useResource } from "../../api/hooks.js";
import { Card, Resource } from "../../components/ui.jsx";

export function ManagedStation({ children }) {
  const stations = useResource("/stations/managed");
  return (
    <Resource result={stations}>
      {({ stations }) =>
        stations.length ? (
          children(stations[0])
        ) : (
          <Card title="No managed station">
            <p className="empty">
              A station must be assigned to your manager account before you can
              use this workspace.
            </p>
          </Card>
        )
      }
    </Resource>
  );
}
