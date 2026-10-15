export function toDatetimeLocal(seconds = Math.floor(Date.now() / 1000)): string {
  const date = new Date(seconds * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromDatetimeLocal(value: string): number {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Choose a valid date and time');
  return Math.floor(milliseconds / 1000);
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return 'Waiting for anchor';
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
