/**
 * Against a captured `tailscale status --json` (`fixtures/README.md` says which
 * tailnet and which version), never the real binary and never a real tailnet —
 * CI has neither. Each unmet precondition is that fixture with one field taken
 * away, which is also the only way three of them could be reached at all.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { TailscaleError, funnelHostname } from './tailscale.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'tailscale-status.json');

/** Only the fields these tests take away; the rest of the file rides along. */
type Fixture = {
  BackendState: string;
  Self: {
    CapMap?: Record<string, unknown> | undefined;
    Capabilities?: string[] | undefined;
    DNSName?: string | undefined;
  };
};

/** A fresh copy each time, parsed from disk, so one test's edit cannot reach another's. */
async function status(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
}

/**
 * Removes a capability from both shapes at once. A real node carries the same
 * set in `CapMap` and in the deprecated `Capabilities` beside it, so a test that
 * dropped one and left the other would be asserting about a node that cannot exist.
 */
function withoutCap(s: Fixture, cap: string): Fixture {
  delete s.Self.CapMap?.[cap];
  s.Self.Capabilities = s.Self.Capabilities?.filter((c) => c !== cap);
  return s;
}

/** Asserts the refusal is a `TailscaleError` and that it says the given thing. */
function refuses(value: unknown, says: RegExp): void {
  assert.throws(
    () => funnelHostname(value),
    (error: unknown) => {
      assert.ok(error instanceof TailscaleError, `not a TailscaleError: ${String(error)}`);
      assert.match(error.message, says);
      return true;
    },
  );
}

test('derives the machine’s public name, without the trailing dot', async () => {
  assert.equal(funnelHostname(await status()), 'my-box.tailnet-1234.ts.net');
});

test('the deprecated Capabilities list answers when CapMap is absent', async () => {
  const s = await status();
  delete s.Self.CapMap;
  assert.equal(funnelHostname(s), 'my-box.tailnet-1234.ts.net');
});

test('not logged in is named as that, and not as a missing capability', async () => {
  // The real shape of a logged-out node: it reports no capabilities at all, so
  // a Funnel check running first would tell someone to edit their tailnet's
  // access controls when what they need to do is sign in.
  const s = await status();
  s.BackendState = 'NeedsLogin';
  s.Self.CapMap = {};
  delete s.Self.Capabilities;
  refuses(s, /not running \(state: NeedsLogin\)[\s\S]*tailscale up/);
});

test('a stopped tailscale is the same answer, naming its own state', async () => {
  const s = await status();
  s.BackendState = 'Stopped';
  refuses(s, /state: Stopped/);
});

test('Funnel not permitted on the tailnet points at the access controls', async () => {
  refuses(
    withoutCap(await status(), 'funnel'),
    /Funnel is not enabled for this machine[\s\S]*admin\/acls\/file/,
  );
  // An empty set is a node the control plane granted nothing, which is that
  // same refusal — it is a set, and `funnel` is not in it.
  const empty = await status();
  empty.Self.CapMap = {};
  empty.Self.Capabilities = [];
  refuses(empty, /Funnel is not enabled for this machine/);
});

test('a signed-in node reporting no capability set at all is not a refusal', async () => {
  // The case that has no coverage and is not the same as an empty set: a
  // `Running` node whose status carries neither shape has said nothing about
  // its tailnet's access controls. Refusing here sends someone to add an
  // attribute their policy already has, at the one precondition with no command
  // to run — which is exactly what install.sh's own probe did.
  const s = await status();
  delete s.Self.CapMap;
  delete s.Self.Capabilities;
  assert.equal(funnelHostname(s), 'my-box.tailnet-1234.ts.net');
  // And it is still only the capability questions that are waived: everything
  // knowable from the document is still answered.
  const nameless = await status();
  delete nameless.Self.CapMap;
  delete nameless.Self.Capabilities;
  delete nameless.Self.DNSName;
  refuses(nameless, /no MagicDNS name/);
});

test('HTTPS certificates off is its own answer, not the Funnel one', async () => {
  refuses(withoutCap(await status(), 'https'), /HTTPS certificates[\s\S]*admin\/dns/);
});

test('no MagicDNS name is refused rather than guessed at from HostName', async () => {
  const s = await status();
  delete s.Self.DNSName;
  refuses(s, /no MagicDNS name/);
  // A bare dot is the root zone, not a name — the trailing-dot strip must not
  // turn it into an empty hostname the banner would print as `https:///`.
  const bare = await status();
  bare.Self.DNSName = '.';
  refuses(bare, /no MagicDNS name/);
});

test('junk is a refusal, never a throw of some other kind', () => {
  for (const value of [undefined, null, 42, 'Running', {}, { Self: 7 }, []]) {
    refuses(value, /not running/);
  }
});
