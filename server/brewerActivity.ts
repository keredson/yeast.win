import type Database from 'better-sqlite3';
import { nowSeconds } from '../shared/schema.ts';

export interface ActivityDay { date: string; count: number }
export interface BrewerActivity {
  time_zone: string;
  start_date: string;
  through_date: string;
  total: number;
  days: ActivityDay[];
}

function dateKey(milliseconds: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(milliseconds);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function calendarDate(offset: number, today: string): string {
  const [year, month, day] = today.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

export function activityWindow(timeZone: string, now = Date.now()): { today: string; start: string; end: string } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = dateKey(now, formatter);
  return { today, start: calendarDate(-365, today), end: calendarDate(-1, today) };
}

/** Daily cache deliberately leaves new activity out until the next local day. */
export function brewerActivity(auth: Database.Database, accountId: string, timeZone: string,
  workspaceIds: string[], workspaceDb: (id: string) => Database.Database, now = Date.now()): BrewerActivity {
  const { today, start, end } = activityWindow(timeZone, now);
  const cached = auth.prepare('SELECT data_json FROM brewer_activity_cache WHERE account_id = ? AND time_zone = ? AND through_date = ?')
    .get(accountId, timeZone, end) as { data_json: string } | undefined;
  if (cached) {
    try { return JSON.parse(cached.data_json) as BrewerActivity; }
    catch { /* Rebuild a damaged cache entry. */ }
  }

  const days: ActivityDay[] = Array.from({ length: 365 }, (_, index) =>
    ({ date: calendarDate(index - 365, today), count: 0 }));
  const byDate = new Map(days.map(day => [day.date, day]));
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  // All IANA offsets fit within one day. This wider UTC range includes the boundary dates.
  const from = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000) - 86_400;
  const until = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000) + 86_400;
  const times = `SELECT created_at AS at FROM batches WHERE created_at >= ? AND created_at < ?
    UNION ALL SELECT created_at AS at FROM recipes WHERE created_at >= ? AND created_at < ?
    UNION ALL SELECT actual_at AS at FROM batch_events WHERE actual_at >= ? AND actual_at < ?`;
  for (const id of workspaceIds) {
    const rows = workspaceDb(id).prepare(times).all(from, until, from, until, from, until) as { at: number }[];
    for (const row of rows) {
      const day = byDate.get(dateKey(row.at * 1000, formatter));
      if (day) day.count++;
    }
  }
  const result = { time_zone: timeZone, start_date: start, through_date: end,
    total: days.reduce((sum, day) => sum + day.count, 0), days };
  auth.prepare(`INSERT INTO brewer_activity_cache(account_id, time_zone, through_date, data_json, generated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET time_zone = excluded.time_zone,
      through_date = excluded.through_date, data_json = excluded.data_json, generated_at = excluded.generated_at`)
    .run(accountId, timeZone, end, JSON.stringify(result), nowSeconds());
  return result;
}
