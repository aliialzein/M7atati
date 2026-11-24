export const iso = (value) => (value ? new Date(value).toISOString() : "");
export const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
export const humanize = (value) =>
  value
    ?.toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (initial) => initial.toUpperCase()) ?? "—";
export const money = (minor, currency) => {
  if (minor == null) return "—";
  if (!currency) return `${minor} minor units`;
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(
    minor / (currency === "USD" ? 100 : 1),
  );
};
