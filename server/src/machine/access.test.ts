import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { accessHealthy, formatAccessReport, inspectAccess, probe } from './access.ts';

const HOST = 'my-box.tailnet-1234.ts.net';
const ARMED = {
  Web: {
    [`${HOST}:443`]: {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } },
    },
  },
  AllowFunnel: { [`${HOST}:443`]: true },
};

test('access status proves the configured Host locally and the real public URL', async () => {
  const seen: { url: string; host?: string | undefined; body?: string | undefined }[] = [];
  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ARMED,
    probe: async (url, host, body) => {
      seen.push({ url: url.toString(), host, body });
      return url.protocol === 'http:' ? 401 : 200;
    },
  });

  assert.deepEqual(seen, [
    {
      url: 'http://127.0.0.1:8787/api/machines/local/sessions',
      host: HOST,
      body: '{"error":"unauthorized"}',
    },
    { url: `https://${HOST}/`, host: undefined, body: undefined },
  ]);
  assert.equal(accessHealthy(report), true);
  assert.match(formatAccessReport(report), /browser only/);
  assert.match(formatAccessReport(report), /Funnel:\s+on/);
  assert.match(formatAccessReport(report), /public HTTPS: HTTP 200/);
});

test('a private Serve mapping is never presented as a clientless public link', async () => {
  let probes = 0;
  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ({ Web: ARMED.Web }),
    probe: async () => {
      probes += 1;
      return 200;
    },
  });

  assert.equal(probes, 0);
  assert.equal(accessHealthy(report), false);
  assert.match(formatAccessReport(report), /Funnel:\s+not armed/);
  assert.match(formatAccessReport(report), /tether:\s+not reachable/);
});

test('access status will not follow a non-loopback proxy target', async () => {
  let probes = 0;
  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ({
      Web: {
        [`${HOST}:443`]: {
          Handlers: { '/': { Proxy: 'http://169.254.169.254/latest/meta-data' } },
        },
      },
      AllowFunnel: { [`${HOST}:443`]: true },
    }),
    probe: async () => {
      probes += 1;
      return 200;
    },
  });

  assert.equal(probes, 0);
  assert.equal(report.proxyTarget, 'http://169.254.169.254/latest/meta-data');
  assert.equal(accessHealthy(report), false);
});

test('a failed public check is named independently of a healthy backend', async () => {
  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ARMED,
    probe: async (url) => (url.protocol === 'http:' ? 401 : undefined),
  });

  assert.equal(report.localStatus, 401);
  assert.equal(report.publicStatus, undefined);
  assert.equal(accessHealthy(report), false);
  assert.match(formatAccessReport(report), /tether:\s+HTTP 401/);
  assert.match(formatAccessReport(report), /public HTTPS: not reachable/);
});

test('a catch-all HTTP 200 is not identified as tether', async () => {
  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ARMED,
    probe: async (url, _host, expectedBody) =>
      url.protocol === 'http:' && expectedBody === undefined ? 200 : undefined,
  });

  assert.equal(report.localStatus, undefined);
  assert.equal(accessHealthy(report), false);
});

test('an oversized catch-all response settles as unhealthy', async (t) => {
  const server = createServer((_request, response) => response.end('x'.repeat(1_000)));
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address !== null && typeof address === 'object');

  const report = await inspectAccess({
    hostname: async () => HOST,
    serveStatus: async () => ({
      Web: {
        [`${HOST}:443`]: {
          Handlers: { '/': { Proxy: `http://127.0.0.1:${address.port}` } },
        },
      },
      AllowFunnel: { [`${HOST}:443`]: true },
    }),
    probe: async (url, host, body) => (url.protocol === 'http:' ? probe(url, host, body) : 200),
  });

  assert.equal(report.localStatus, undefined);
  assert.equal(accessHealthy(report), false);
});
