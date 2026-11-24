import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api/client.js";
import { branchPath, features, isDashboardUser } from "../src/app/access.js";

const manager = { id: 1, role: "MANAGER", permissions: ["orders.read"] };

function mockSession(t, canRefresh) {
  const calls = [];
  let active = false;
  const events = new EventTarget();
  globalThis.window = events;
  t.after(() => {
    delete globalThis.window;
  });
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/auth/refresh") {
      if (!canRefresh)
        return Response.json({ message: "Session expired" }, { status: 401 });
      active = true;
      return Response.json({ user: manager });
    }
    if (!active)
      return Response.json({ message: "Unauthenticated" }, { status: 401 });
    return Response.json(
      path === "/api/auth/me" ? { user: manager } : { authenticated: true },
    );
  });
  return { calls, events };
}

test("refreshes a manager session once when parallel branch requests return 401", async (t) => {
  const { calls } = mockSession(t, true);
  const orders = "/manager/stations/12/orders";
  const [list, detail] = await Promise.all([api(orders), api(`${orders}/42`)]);
  assert.deepEqual(
    [list, detail],
    [{ authenticated: true }, { authenticated: true }],
  );
  const refreshes = calls.filter(({ path }) => path === "/api/auth/refresh");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].options.headers["X-CSRF-Protection"], "1");
  assert.equal(refreshes[0].options.credentials, "include");
});

test("ends a dashboard session when the API rejects refresh", async (t) => {
  const { calls, events } = mockSession(t, false);
  const updates = [];
  events.addEventListener("smartstation-session", (event) =>
    updates.push(event.detail),
  );
  const orders = "/manager/stations/12/orders";
  await assert.rejects(api(orders), { status: 401 });
  assert.equal(calls.filter(({ path }) => path === `/api${orders}`).length, 1);
  assert.deepEqual(updates, [null]);
});

test("only the executive and station manager roles enter the dashboard", () => {
  const principal = (role) => ({
    role,
    permissions: ["stations.read", "orders.read"],
  });
  for (const role of ["HR", "EMPLOYEE", "CUSTOMER", "SECURITY"]) {
    assert.equal(isDashboardUser(principal(role)), false);
    assert.deepEqual(
      features.filter((feature) => feature.show(principal(role))),
      [],
    );
  }
  assert.equal(isDashboardUser(principal("ADMIN")), true);
  assert.equal(isDashboardUser(principal("MANAGER")), true);
  assert.equal(branchPath(principal("ADMIN"), 2), "/admin/stations/2");
  assert.equal(branchPath(principal("MANAGER"), 2), "/manager/stations/2");
});
