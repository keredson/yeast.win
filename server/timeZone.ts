import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

/** GeoLite2 City is optional. The database is managed by geoipupdate on the host. */
export function timeZoneForIp(ip: string): string | null {
  if (!isIP(ip)) return null;
  const database = [process.env.BREWLOG_GEOIP_DB, '/var/lib/GeoIP/GeoLite2-City.mmdb',
    '/usr/share/GeoIP/GeoLite2-City.mmdb'].find(path => path && existsSync(path));
  if (!database) return null;
  try {
    const output = execFileSync('mmdblookup', ['--file', database, '--ip', ip, 'location', 'time_zone'],
      { encoding: 'utf8', timeout: 1500, maxBuffer: 4096 });
    const timeZone = /^\s*"([^"]+)"\s+<utf8_string>/m.exec(output)?.[1];
    return validTimeZone(timeZone) ? timeZone : null;
  } catch { return null; }
}

export function registrationTimeZone(ip: string, browserTimeZone: unknown): string {
  return timeZoneForIp(ip) || (validTimeZone(browserTimeZone) ? browserTimeZone : 'UTC');
}
