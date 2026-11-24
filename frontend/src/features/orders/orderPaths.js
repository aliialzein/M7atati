export const orderPath = (role, stationId) =>
  role === "MANAGER"
    ? `/manager/stations/${stationId}/orders`
    : role === "EMPLOYEE"
      ? "/employee/orders"
      : "/orders";
