import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api/client.js";

const customer = {
  id: 1,
  role: "CUSTOMER",
  permissions: ["orders.read", "orders.create"],
};

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
    if (path === "/api/auth/me") {
      return active
        ? Response.json({ user: customer })
        : Response.json({ message: "Unauthenticated" }, { status: 401 });
    }
    if (path === "/api/auth/refresh") {
      if (!canRefresh)
        return Response.json({ message: "Session expired" }, { status: 401 });
      active = true;
      return Response.json({ user: customer });
    }
    return Response.json({ authenticated: active });
  });
  return { calls, events };
}

test("checks an authenticated customer session before using an order route that also accepts guests", async (t) => {
  const { calls } = mockSession(t, true);
  const [order, events] = await Promise.all([
    api("/orders/42", { ensureSession: true }),
    api("/orders/42/events", { ensureSession: true }),
  ]);
  assert.equal(order.authenticated, true);
  assert.equal(events.authenticated, true);
  const paths = calls.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === "/api/auth/refresh").length, 1);
  assert.ok(
    paths.indexOf("/api/auth/refresh") < paths.indexOf("/api/orders/42"),
  );
  const refresh = calls.find(({ path }) => path === "/api/auth/refresh");
  assert.equal(refresh.options.headers["X-CSRF-Protection"], "1");
  assert.equal(refresh.options.credentials, "include");
});

test("does not fall back to guest checkout if the customer session cannot be recovered", async (t) => {
  const { calls, events } = mockSession(t, false);
  const updates = [];
  events.addEventListener("smartstation-session", (event) =>
    updates.push(event.detail),
  );
  await assert.rejects(
    api("/orders/quotes", { method: "POST", body: {}, ensureSession: true }),
    { status: 401 },
  );
  assert.equal(
    calls.some(({ path }) => path === "/api/orders/quotes"),
    false,
  );
  assert.deepEqual(updates, [null]);
});

test("reads an explicitly guest-owned order without refreshing or exposing its capability in the URL", async (t) => {
  const { calls } = mockSession(t, false);
  await api("/orders/42", {
    public: true,
    guestToken: "guest-tracking-capability",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/orders/42");
  assert.equal(
    calls[0].options.headers["X-Order-Access-Token"],
    "guest-tracking-capability",
  );
});
