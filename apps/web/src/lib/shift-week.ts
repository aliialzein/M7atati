export const SHIFT_TIMEZONE = 'Asia/Beirut';

// These are calendar labels, not instants. UTC arithmetic here deliberately
// avoids the browser timezone; the API resolves each Beirut midnight to UTC.
export function moveShiftWeek(weekStart: string, weeks: number) {
  const date = new Date(`${weekStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

export function currentShiftWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHIFT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  const localDate = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  const monday = new Date(`${localDate}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function localShiftTime(timestamp: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SHIFT_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}
