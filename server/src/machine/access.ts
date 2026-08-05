import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { funnelHost, funnelProxyTarget, tailscaleServeStatus } from './tailscale.ts';

const PROBE_TIMEOUT_MS = 5_000;

export type AccessReport = {
  hostname: string;
  publicUrl: string;
  proxyTarget?: string | undefined;
  localStatus?: number | undefined;
  publicStatus?: number | undefined;
};

type AccessDependencies = {
  hostname(): Promise<string>;
  serveStatus(): Promise<unknown>;
  probe(url: URL, host?: string | undefined, body?: string | undefined): Promise<number | undefined>;
};

/**
 * One bounded HTTP request. The loopback check supplies the public Host because
 * accepting that Host is part of `--funnel`; a bare 127.0.0.1 check can pass on
 * a server that will return 403 to every real Funnel request.
 */
async function probe(
  url: URL,
  host?: string | undefined,
  expectedBody?: string | undefined,
): Promise<number | undefined> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = request(
      url,
      {
        method: 'GET',
        ...(host === undefined ? {} : { headers: { Host: host } }),
      },
      (response) => {
        if (expectedBody === undefined) {
          response.resume();
          resolve(response.statusCode);
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > Buffer.byteLength(expectedBody)) response.destroy();
          else chunks.push(chunk);
        });
        response.once('end', () =>
          resolve(Buffer.concat(chunks).toString() === expectedBody ? response.statusCode : undefined),
        );
        response.once('error', () => resolve(undefined));
      },
    );
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy());
    req.once('error', () => resolve(undefined));
    req.end();
  });
}

const DEFAULT_DEPENDENCIES: AccessDependencies = {
  hostname: funnelHost,
  serveStatus: tailscaleServeStatus,
  probe,
};

/**
 * Read the three independently useful facts: Tailscale's public mapping, the
 * backend answering for that mapping's Host, and the actual public HTTPS URL.
 * None stands in for another, so the report says exactly where setup stopped.
 */
export async function inspectAccess(
  dependencies: AccessDependencies = DEFAULT_DEPENDENCIES,
): Promise<AccessReport> {
  const hostname = await dependencies.hostname();
  const publicUrl = `https://${hostname}/`;
  const status = await dependencies.serveStatus();
  const proxyTarget = funnelProxyTarget(status, hostname);
  if (proxyTarget === undefined) return { hostname, publicUrl };

  let target: URL;
  try {
    target = new URL(proxyTarget);
  } catch {
    return { hostname, publicUrl, proxyTarget };
  }

  // Funnel is deliberately composed around a loopback HTTP origin. A status
  // document naming anything else is shown, but never probed or called tether:
  // following an arbitrary URL from machine-wide configuration would turn a
  // read-only status command into an SSRF client.
  const loopback =
    target.protocol === 'http:' && (target.hostname === '127.0.0.1' || target.hostname === '[::1]');
  if (!loopback) return { hostname, publicUrl, proxyTarget };

  const [localStatus, publicStatus] = await Promise.all([
    dependencies.probe(
      new URL('/api/machines/local/sessions', target),
      hostname,
      '{"error":"unauthorized"}',
    ),
    dependencies.probe(new URL(publicUrl)),
  ]);
  return { hostname, publicUrl, proxyTarget, localStatus, publicStatus };
}

function result(status: number | undefined): string {
  return status === undefined ? 'not reachable' : `HTTP ${status}`;
}

/** The stable, copyable diagnosis `tether access status` prints. */
export function formatAccessReport(report: AccessReport): string {
  return [
    `public URL:  ${report.publicUrl}`,
    'viewer:      browser only — no Tailscale account or app needed',
    `Funnel:      ${report.proxyTarget === undefined ? 'not armed for this host' : `on → ${report.proxyTarget}`}`,
    `tether:      ${result(report.localStatus)}`,
    `public HTTPS: ${result(report.publicStatus)}`,
  ].join('\n');
}

export function accessHealthy(report: AccessReport): boolean {
  return (
    report.proxyTarget !== undefined && report.localStatus === 401 && report.publicStatus === 200
  );
}
