import { isIP } from 'node:net';

type HeaderValue = string | string[] | undefined;

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requestAddress(socketAddress: string | undefined, connectingIp: HeaderValue,
  trustCloudflare: boolean): string {
  if (trustCloudflare) {
    const candidate = firstHeader(connectingIp)?.trim();
    if (candidate && isIP(candidate)) return candidate;
  }
  return socketAddress || 'unknown';
}

export function requestIsSecure(socketEncrypted: boolean, forwardedProto: HeaderValue,
  trustCloudflare: boolean): boolean {
  if (socketEncrypted) return true;
  return trustCloudflare && firstHeader(forwardedProto)?.trim().toLowerCase() === 'https';
}
