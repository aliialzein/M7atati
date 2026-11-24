import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { query } from "../../api/client.js";
import { useResource } from "../../api/hooks.js";
import { useAuth } from "../auth/AuthProvider.jsx";
import {
  Badge,
  Button,
  Card,
  Pagination,
  Resource,
  Table,
  Title,
} from "../../components/ui.jsx";
import { ManagedStation } from "./ManagedStation.jsx";

export function BranchDirectory({ actions }) {
  const [page, setPage] = useState(1);
  const branches = useResource(query("/stations", { page }));
  return (
    <Card title="Branch directory">
      <Resource result={branches}>
        {({ stations, pagination }) => (
          <>
            <Table
              columns={["Branch", "Address", "Status", "Open"]}
              rows={stations.map((station) => ({
                id: station.id,
                cells: [
                  station.name,
                  station.address || "—",
                  <Badge tone={station.isActive ? "green" : ""}>
                    {station.isActive ? "Active" : "Inactive"}
                  </Badge>,
                  <div className="actions">{actions(station)}</div>,
                ],
              }))}
              empty="No branches are registered yet."
            />
            <Pagination data={pagination} page={page} setPage={setPage} />
          </>
        )}
      </Resource>
    </Card>
  );
}

function ExecutiveBranch({ title, returnTo, children }) {
  const [params] = useSearchParams();
  const id = params.get("branch");
  const valid = /^[1-9][0-9]{0,9}$/.test(id || "") && Number(id) <= 2147483647;
  const branch = useResource(valid ? `/stations/${id}` : null);
  if (!valid)
    return (
      <>
        <Title
          title={title}
          description="Choose a branch to view its records."
        />
        {id !== null && (
          <p role="alert" className="notice error">
            Invalid branch number.
          </p>
        )}
        <BranchDirectory
          actions={(station) => (
            <Button
              to={query(returnTo, { branch: station.id })}
              aria-label={`View ${title.toLowerCase()} for ${station.name}`}
            >
              View branch
            </Button>
          )}
        />
      </>
    );
  return (
    <>
      <div className="branch-toolbar">
        <Button to={returnTo}>← All branches</Button>
      </div>
      <Resource result={branch}>{({ station }) => children(station)}</Resource>
    </>
  );
}

export function BranchWorkspace({ title, returnTo, children }) {
  const { user } = useAuth();
  if (user.role === "MANAGER")
    return <ManagedStation>{children}</ManagedStation>;
  return (
    <ExecutiveBranch title={title} returnTo={returnTo}>
      {children}
    </ExecutiveBranch>
  );
}
