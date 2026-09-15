const dtf = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const tf = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
});

const df = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "short",
});

export function formatDateTime(iso: string): string {
  return dtf.format(new Date(iso));
}

export function formatTime(iso: string): string {
  return tf.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return df.format(new Date(iso));
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `לפני ${days} ימים`;
  return formatDay(iso);
}

export function fullName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ");
}
