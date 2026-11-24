export const has = (user, ...keys) =>
  keys.every((key) => user?.permissions.includes(key));
const inRole = (user, ...roles) => roles.includes(user?.role);
export const isDashboardUser = (user) => inRole(user, "ADMIN", "MANAGER");
export const dashboardRole = (user) =>
  user.role === "ADMIN" ? "General CEO" : "Station Manager";
export const branchPath = (user, stationId) =>
  `/${user.role === "ADMIN" ? "admin" : "manager"}/stations/${stationId}`;

const canReadStationData = (user, ...permissions) =>
  isDashboardUser(user) &&
  has(
    user,
    ...permissions,
    ...(user.role === "ADMIN" ? ["stations.read"] : []),
  );

export const features = [
  {
    path: "/orders",
    label: "Orders",
    text: "Track or manage fuel orders.",
    icon: "orders",
    show: (u) => canReadStationData(u, "orders.read"),
  },
  {
    path: "/attendance",
    label: "Attendance",
    text: "View clock-in and clock-out records.",
    icon: "team",
    show: (u) => isDashboardUser(u) && has(u, "attendance.read"),
  },
  {
    path: "/shifts",
    label: "Shifts",
    text: "Review scheduled shifts.",
    icon: "team",
    show: (u) => inRole(u, "ADMIN") && has(u, "shifts.read"),
  },
  {
    path: "/reports",
    label: "Analytics",
    text: "Review station orders and attendance totals.",
    icon: "reports",
    show: (u) =>
      canReadStationData(u, "reports.read", "attendance.read", "orders.read"),
  },
  {
    path: "/people",
    label: "People",
    text: "View and manage staff accounts.",
    icon: "team",
    show: (u) => isDashboardUser(u) && has(u, "users.read"),
  },
  {
    path: "/stations",
    label: "Branches",
    text: "View branch details, manager assignments, and pump availability.",
    icon: "settings",
    show: (u) =>
      (inRole(u, "ADMIN") && has(u, "stations.read")) || inRole(u, "MANAGER"),
  },
  {
    path: "/fuel",
    label: "Fuel prices",
    text: "View reference prices and manage selling tariffs.",
    icon: "fuel",
    show: (u) => inRole(u, "ADMIN") && has(u, "pricing.read"),
  },
];
