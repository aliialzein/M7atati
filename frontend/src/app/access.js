export const has = (user, ...keys) =>
  keys.every((key) => user?.permissions.includes(key));
const inRole = (user, ...roles) => roles.includes(user?.role);

export const features = [
  {
    path: "/orders/new",
    label: "Order fuel",
    text: "Get a price quote and place a fuel order.",
    icon: "fuel",
    show: (u) => !u || (inRole(u, "CUSTOMER") && has(u, "orders.create")),
  },
  {
    path: "/orders",
    label: "Orders",
    text: "Track or manage fuel orders.",
    icon: "orders",
    show: (u) =>
      inRole(u, "CUSTOMER", "EMPLOYEE", "MANAGER") && has(u, "orders.read"),
  },
  {
    path: "/attendance",
    label: "Attendance",
    text: "View clock-in and clock-out records.",
    icon: "team",
    show: (u) =>
      inRole(u, "ADMIN", "HR", "MANAGER", "EMPLOYEE") &&
      has(u, "attendance.read"),
  },
  {
    path: "/shifts",
    label: "Shifts",
    text: "Review scheduled shifts.",
    icon: "team",
    show: (u) => inRole(u, "ADMIN", "HR", "EMPLOYEE") && has(u, "shifts.read"),
  },
  {
    path: "/reports",
    label: "Analytics",
    text: "Review station orders and attendance totals.",
    icon: "reports",
    show: (u) =>
      inRole(u, "MANAGER") &&
      has(u, "reports.read", "attendance.read", "orders.read"),
  },
  {
    path: "/people",
    label: "People",
    text: "View and manage staff accounts.",
    icon: "team",
    show: (u) => inRole(u, "ADMIN", "MANAGER", "HR") && has(u, "users.read"),
  },
  {
    path: "/stations",
    label: "Stations",
    text: "Manage stations, assignments, and pump availability.",
    icon: "settings",
    show: (u) =>
      (inRole(u, "ADMIN") && has(u, "stations.read")) ||
      (inRole(u, "MANAGER") && has(u, "payments.manage")),
  },
  {
    path: "/fuel",
    label: "Fuel prices",
    text: "View reference prices and manage selling tariffs.",
    icon: "fuel",
    show: (u) => inRole(u, "ADMIN") && has(u, "pricing.read"),
  },
];
