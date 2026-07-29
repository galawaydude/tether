/**
 * Serving the built browser app.
 *
 * Two named routes rather than `@fastify/static`'s wildcard, and the plugin is
 * registered with `serve: false` so all it contributes is `reply.sendFile` — the
 * traversal-safe path resolution, content types and etags that report §6 says are
 * worth a dependency. The wildcard would answer every unmatched path publicly,
 * which would hand an unauthenticated caller a 404-vs-401 oracle for which API
 * routes exist; the default-deny hook in `server.ts` exists to deny it that.
 *
 * These are the only two public routes besides `/api/login`, and they are public
 * for the obvious reason: the login screen cannot ask for a session while being
 * gated on one.
 */

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `web/dist`. Three levels up from this module both in the source tree it runs
 * from (`npm run tether`, `node --test`) and in the `dist/` it is built into.
 */
export const WEB_DIST = join(import.meta.dirname, '..', '..', '..', 'web', 'dist');

/** Vite's output filenames: `index-<hash>.js`, `index-<hash>.css`. */
const ASSET_PARAMS = {
  type: 'object',
  required: ['file'],
  additionalProperties: false,
  properties: { file: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' } },
} as const;

export function registerStatic(app: FastifyInstance, root: string = WEB_DIST): void {
  if (!existsSync(join(root, 'index.html'))) {
    // A server that answers every page with a 404 is a confusing thing to debug,
    // and this is the likely state during development on the server alone.
    process.stderr.write(`!! no browser app at ${root} — run \`npm run build\`.\n`);
    return;
  }

  app.register(fastifyStatic, { root, serve: false });

  app.get('/', { config: { public: true } }, async (_request, reply) =>
    reply.sendFile('index.html'),
  );

  app.get<{ Params: { file: string } }>(
    '/assets/:file',
    { config: { public: true }, schema: { params: ASSET_PARAMS } },
    async (request, reply) => reply.sendFile(join('assets', request.params.file)),
  );
}
