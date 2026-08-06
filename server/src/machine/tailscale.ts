/**
 * The whole of what tether knows about Tailscale: structured status documents,
 * and only the fields `serve --funnel` and `access status` read out of them.
 *
 * It only ever *reads*. Turning Funnel on needs root or an operator and changes
 * a machine-wide setting that outlives the server, so `install.sh` asks for that
 * under its own consent contract; this answers two questions only — can Funnel
 * work here, and what name would it use. That split is why there is no Tailscale
 * client, no daemon and no cached state here: a subprocess and a JSON parse.
 *
 * Every field below was read off a real tailnet (tailscale 1.98.10); the two
 * capability names are Tailscale's own, and the two failure sentences are the
 * ones its CLI prints for the same conditions.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The command excludes peers because every question is about Self. Keep an
 * explicit ceiling anyway: `execFile` otherwise kills a child at Node's 1 MiB
 * default and hands back truncated stdout, which looks like malformed JSON
 * rather than the real failure. Truncation is named below instead of left to
 * the parser.
 */
const STATUS_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A precondition the user has to fix, carrying the sentence that says how.
 * Distinct from a bug: `serve` prints `message` and exits 1 rather than throwing
 * a stack trace at somebody who simply has not logged in yet.
 */
export class TailscaleError extends Error {}

/** Set on a node whose tailnet permits Funnel at all (`tailcfg.NodeAttrFunnel`). */
const FUNNEL_ATTR = 'funnel';
/** Funnel terminates TLS, so a tailnet with HTTPS certificates off cannot serve it. */
const HTTPS_ATTR = 'https';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * This machine's public Funnel name, from the JSON `tailscale status --json`
 * prints — `Self.DNSName` without its trailing dot.
 *
 * The order of the checks is the order the answers become knowable: `CapMap` is
 * empty on a logged-out node, so asking about Funnel first would report a
 * missing capability to someone who has simply not signed in. The same
 * distinction runs one level deeper inside the capability check itself — see
 * there.
 */
export function funnelHostname(status: unknown): string {
  const root = record(status);
  const self = record(root?.['Self']);
  const state = root?.['BackendState'];

  if (state !== 'Running') {
    throw new TailscaleError(
      `Tailscale is installed but not running (state: ${typeof state === 'string' ? state : 'unknown'}).\n` +
        'Run `sudo tailscale up`, finish signing in, and try again.',
    );
  }

  // `CapMap` is the current shape and `Capabilities` the deprecated list beside
  // it; both were populated on the node this was read from, so either answering
  // is enough and neither is required to exist.
  //
  // **Neither existing is a third answer, and it is not "no".** An empty
  // capability set is a node the control plane granted nothing, which is a real
  // refusal worth naming; a node that reported no set at all has said nothing
  // about its tailnet's access controls, and turning that silence into the two
  // refusals below tells someone to add an attribute their policy may already
  // have — with no way forward, since neither is a command anyone can run.
  // So this carries on instead: `serve --funnel` binds loopback either way, and
  // Funnel itself refuses in its own words if the tailnet really does forbid it.
  // Nothing is being gated here — the password rule and the loopback bind are
  // what make `--funnel` safe, and both are elsewhere.
  const capMap = record(self?.['CapMap']);
  const capList = Array.isArray(self?.['Capabilities'])
    ? (self['Capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : undefined;
  const caps =
    capMap || capList
      ? new Set<string>([...Object.keys(capMap ?? {}), ...(capList ?? [])])
      : undefined;

  if (caps && !caps.has(FUNNEL_ATTR)) {
    throw new TailscaleError(
      'Funnel is not enabled for this machine, so it cannot have a public address.\n' +
        'It is a one-time change: the "funnel" node attribute has to apply to this\n' +
        'machine in your access controls at https://login.tailscale.com/admin/acls/file\n' +
        'Having it is not the same as it reaching here — the default policy grants it\n' +
        'to "autogroup:member", and a machine joined with a tagged auth key is not one.\n' +
        'What to add: https://tailscale.com/s/no-funnel',
    );
  }
  if (caps && !caps.has(HTTPS_ATTR)) {
    throw new TailscaleError(
      'Funnel needs HTTPS certificates, and they are off for this tailnet.\n' +
        'Turn them on once at https://login.tailscale.com/admin/dns\n' +
        'Details: https://tailscale.com/s/https',
    );
  }

  const dnsName = self?.['DNSName'];
  if (typeof dnsName !== 'string' || dnsName.replace(/\.$/, '') === '') {
    throw new TailscaleError(
      'Tailscale is running, but reports no MagicDNS name for this machine, so\n' +
        'Remote Control Agent cannot work out its public address. Enable MagicDNS at\n' +
        'https://login.tailscale.com/admin/dns and try again.',
    );
  }
  return dnsName.replace(/\.$/, '');
}

/**
 * `tailscale status --json`, or the one sentence to read if the binary is not
 * there. Its exit status is not consulted: a logged-out `tailscale` exits 1 and
 * still prints the JSON that says so, which is a better message than "exit 1".
 */
export async function tailscaleStatus(): Promise<unknown> {
  let stdout: string;
  try {
    // Every question is about Self. Excluding peers prevents a large tailnet
    // from turning one local status read into tens of megabytes and prevents a
    // peer's DNS name or capabilities from ever being mistaken for this node's.
    ({ stdout } = await run('tailscale', ['status', '--json', '--peers=false'], {
      maxBuffer: STATUS_MAX_BUFFER,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === 'ENOENT') {
      throw new TailscaleError(
        'Tailscale is not installed, and --funnel needs it.\n' +
          'Install it from https://tailscale.com/download — or re-run Remote Control Agent’s\n' +
          'installer, which offers to do it for you.',
      );
    }
    // Said plainly rather than falling through to the parse, where truncated
    // JSON would be reported as tailscale printing something unreadable.
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new TailscaleError(
        `\`tailscale status --json --peers=false\` printed more than ${STATUS_MAX_BUFFER} bytes, so Remote Control Agent\n` +
          'stopped reading it. Run it yourself to see what this node reports.',
      );
    }
    if (typeof err.stdout !== 'string' || err.stdout.trim() === '') {
      throw new TailscaleError(
        `Could not run \`tailscale status --json --peers=false\` — ${err.message}`,
      );
    }
    stdout = err.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new TailscaleError(
      '`tailscale status --json --peers=false` did not print JSON Remote Control Agent could read.',
    );
  }
}

/**
 * The backend URL Funnel currently sends this hostname to, if it is actually
 * public. `tailscale serve status --json` uses the public listener's port in
 * the map key and the local service's port in `Proxy`; both are significant.
 * A private `tailscale serve` entry carries the same proxy but no
 * `AllowFunnel`, and must never be reported as a browser-only public link.
 */
export function funnelProxyTarget(status: unknown, hostname: string): string | undefined {
  const root = record(status);
  const publicName = `${hostname}:443`;
  const allowFunnel = record(root?.['AllowFunnel']);
  if (allowFunnel?.[publicName] !== true) return undefined;

  const web = record(root?.['Web']);
  const publicServer = record(web?.[publicName]);
  const handlers = record(publicServer?.['Handlers']);
  const rootHandler = record(handlers?.['/']);
  const proxy = rootHandler?.['Proxy'];
  return typeof proxy === 'string' && proxy !== '' ? proxy : undefined;
}

/** `tailscale serve status --json`, parsed without scraping its human output. */
export async function tailscaleServeStatus(): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run('tailscale', ['serve', 'status', '--json'], {
      maxBuffer: STATUS_MAX_BUFFER,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === 'ENOENT') {
      throw new TailscaleError(
        'Tailscale is not installed. Install it from https://tailscale.com/download — or\n' +
          're-run Remote Control Agent’s installer, which offers to do it for you.',
      );
    }
    if (typeof err.stdout !== 'string' || err.stdout.trim() === '') {
      throw new TailscaleError(`Could not run \`tailscale serve status --json\` — ${err.message}`);
    }
    stdout = err.stdout;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new TailscaleError(
      '`tailscale serve status --json` did not print JSON Remote Control Agent could read.',
    );
  }
}

/** The status and hostname check composed — what `serve --funnel` calls. */
export async function funnelHost(): Promise<string> {
  return funnelHostname(await tailscaleStatus());
}
