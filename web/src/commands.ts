/**
 * Slash commands from the composer, and where each one's answer turns up.
 *
 * There is no protocol here and no framework: a slash command is **text sent to
 * the pane**, on the same `input` frame a composed message and an option's
 * keystrokes already ride (`options.ts`, `terminal.tsx`). What this module owns
 * is the one thing sending text cannot tell you — whether the user will *see*
 * anything happen — because a command that silently does nothing is the failure
 * mode this surface exists to avoid.
 *
 * Three answers, and each is a property of the command rather than of tether:
 *
 *  - **`conversation`** — the command writes to the provider's transcript, so it
 *    lands as a row above. `/model sonnet` writes `<local-command-stdout>` with
 *    `Set model to Sonnet 5`; `/init` writes the prompt it expands to and runs a
 *    real turn. This is the verified case, and it is the same evidence PR #25's
 *    option bar relies on — the mapper had been dropping those records as noise
 *    until this landed, which is why that bar confirmed nothing.
 *  - **`terminal`** — it prints to the pane and writes nothing. `/cost` and
 *    `/status` are reports, `/clear` starts a fresh transcript. tether cannot
 *    show it, so it says so and offers the terminal.
 *  - **`picker`** — it replaces the screen with a chooser. `/resume` is the one
 *    the captain used, and a chooser is unreachable from a conversation: nothing
 *    is answerable until a selection is made *there*. So the note is the loudest
 *    of the three and comes with the way in.
 *
 * Every entry, and every value on it, was established by driving the installed
 * CLIs in a tmux pane with exactly tether's own input frame (paste, 100ms,
 * Enter) and reading back both the pane and the transcript. Claude Code 2.1.220
 * and codex-cli 0.145.0. The two sets are genuinely different and are not
 * derived from one another.
 *
 * **`answers` is a prediction, and the waiting banner is the correction.** A
 * command can ask a question the table cannot foresee: `/model opus` applies
 * silently on a fresh session and was found, on a real one, opening a *Switch
 * model?* confirmation instead, because switching invalidates a cached
 * conversation. tether already handles that generally — Claude Code publishes
 * `waiting`, `app.tsx`'s banner says so and offers the terminal, and the composer
 * refuses to send until it is answered. So there is no fourth `answers` value and
 * no attempt to enumerate a provider's dialogs: the note says where the answer
 * would go, and the banner says when the agent stopped to ask something instead.
 * The one rule that follows is that a note may never *deny* the other case, which
 * is why none of them says "and nothing else will happen".
 *
 * **What routes as a command at all is `isCommandLine`, and it prefers prose.**
 * Both routes put the same bytes on the same frame, so the choice decides only
 * which feedback tether shows; the rules and the reason they are shaped that way
 * are on that function.
 *
 * **The table is not a gate.** A command it has not heard of is still sent —
 * refusing one would refuse every custom command a user has, and both CLIs ship
 * weekly. What tether says about an unknown one is that it does not know it,
 * which is the same rule the rest of this app follows for anything unrecognised:
 * show what is known, never guess, never throw.
 *
 * Logic lives in a `.ts` for the reason every other decision does: web tests run
 * under `node --test`, which strips types but cannot compile JSX.
 */

import { CODEX, DEFAULT_PROVIDER, providerLabel } from './providers.ts';

/** Where the answer to a command shows up. See the module comment. */
export type Answers = 'conversation' | 'terminal' | 'picker';

export type Command = {
  /** With its slash, exactly as it is typed and sent. */
  readonly name: string;
  /** One line, shown in the composer's own list while a command is typed. */
  readonly summary: string;
  /** Where the answer appears when the command is sent on its own. */
  readonly answers: Answers;
  /**
   * Where it appears **with** an argument, when that is somewhere else. Claude
   * Code's `/model` and `/effort` are the reason this exists and the reason it is
   * not a second entry: bare they open a chooser, and with a value they apply and
   * print a line the transcript keeps — verified, `Set model to Sonnet 5`. One
   * command, two answers, and a user typing either form gets told the truth about
   * the form they typed.
   */
  readonly withArgs?: Answers;
  /**
   * Set when this provider sends an argument to this command **to the model**
   * rather than to the command. Verified on Codex by PR #25 at the cost of a
   * turn: `/model gpt-5.6-terra` is a prompt, and the model answered that it
   * cannot switch itself. The only case tether refuses outright, because the
   * alternative is a paid turn the user did not ask for.
   */
  readonly noArgs?: true;
};

/**
 * Claude Code's commands, as 2.1.220 runs them.
 *
 * `/model` and `/effort` appear here **with and without** an argument, and the
 * difference is the whole reason this table has an `answers` field: with one
 * they apply and print (`Set model to Sonnet 5`, recorded), without one they
 * open a chooser. The option bar in `options.ts` sends the argument form for
 * exactly that reason; this is what a user typing the bare form gets told.
 *
 * `/clear` is `terminal` rather than `conversation` although it is dramatic and
 * instant: it moves the pane to a **new session id and a new transcript** —
 * verified, the same behaviour `CLAUDE.md` already records for `/resume` and
 * `--continue` — so what a user sees is the conversation emptying once tether
 * re-reads the pane, not a line saying it cleared.
 *
 * Deliberately not exhaustive: 2.1.220's `/help` lists dozens, most of them
 * project setup or the user's own skills, and a table that tried to hold them
 * all would be wrong by the next release. These are the ones in a daily loop.
 */
const CLAUDE_COMMANDS: readonly Command[] = [
  { name: '/resume', summary: 'Pick an earlier conversation to continue', answers: 'picker' },
  { name: '/clear', summary: 'Start over with an empty context', answers: 'terminal' },
  {
    name: '/compact',
    summary: 'Summarise the context so far to make room',
    answers: 'conversation',
  },
  { name: '/context', summary: 'What is using up the context window', answers: 'conversation' },
  { name: '/cost', summary: 'What this session has cost so far', answers: 'terminal' },
  { name: '/status', summary: 'Account, model and settings', answers: 'terminal' },
  {
    name: '/model',
    summary: 'Switch model — with a name it applies, without one it asks',
    answers: 'picker',
    withArgs: 'conversation',
  },
  {
    name: '/effort',
    summary: 'How hard to think — with a level it applies, without one it asks',
    answers: 'picker',
    withArgs: 'conversation',
  },
  { name: '/init', summary: 'Write a CLAUDE.md for this project', answers: 'conversation' },
  { name: '/review', summary: 'Review the current changes', answers: 'conversation' },
  { name: '/agents', summary: 'Manage subagents', answers: 'picker' },
  { name: '/config', summary: 'Change settings', answers: 'picker' },
  { name: '/mcp', summary: 'MCP servers and their authentication', answers: 'picker' },
];

/**
 * Codex's commands, as 0.145.0 runs them.
 *
 * The set overlaps by name and not by behaviour, which is the reason this is two
 * tables rather than one with exceptions. Two differences carry all of it:
 *
 *  - **Codex's commands take no argument.** `/model gpt-5.6-terra` reaches the
 *    model as a prompt (PR #25, verified at the cost of a turn), so those
 *    entries are `noArgs` and tether refuses rather than paying for it. `/resume`
 *    is the exception and takes a search term — verified: `/resume nothinghere`
 *    answers `No saved chat found matching 'nothinghere'`.
 *  - **An unrecognised command leaves its text in Codex's composer.** Claude Code
 *    clears the line and prints `Unknown command: /x`; Codex prints
 *    `Unrecognized command '/x'` and the text stays, so the next composed
 *    message would be sent with it stuck on the front. That is what the unknown
 *    note warns about, and it is why the note is worth showing at all.
 *
 * `/permissions` is `terminal`: it opens the fixed three-item picker the option
 * bar drives with a digit, and a user typing it gets the picker itself.
 */
const CODEX_COMMANDS: readonly Command[] = [
  { name: '/resume', summary: 'Pick a saved chat to continue', answers: 'picker' },
  {
    name: '/compact',
    summary: 'Summarise the conversation to make room',
    answers: 'conversation',
    noArgs: true,
  },
  {
    name: '/init',
    summary: 'Write an AGENTS.md for this project',
    answers: 'conversation',
    noArgs: true,
  },
  { name: '/review', summary: 'Review the current changes', answers: 'conversation', noArgs: true },
  { name: '/model', summary: 'Choose model and reasoning effort', answers: 'picker', noArgs: true },
  {
    name: '/permissions',
    summary: 'Choose what Codex is allowed to do',
    answers: 'picker',
    noArgs: true,
  },
  { name: '/plan', summary: 'Switch to Plan mode', answers: 'terminal', noArgs: true },
  { name: '/fork', summary: 'Branch this chat from here', answers: 'picker', noArgs: true },
  { name: '/skills', summary: 'Skills Codex can use', answers: 'picker', noArgs: true },
  {
    name: '/mcp',
    summary: 'MCP servers and their authentication',
    answers: 'picker',
    noArgs: true,
  },
];

const COMMANDS: ReadonlyMap<string, readonly Command[]> = new Map([
  [DEFAULT_PROVIDER, CLAUDE_COMMANDS],
  [CODEX, CODEX_COMMANDS],
]);

/** This provider's commands. A provider this build has not heard of gets none. */
export function commandsFor(provider: string): readonly Command[] {
  return COMMANDS.get(provider) ?? [];
}

/**
 * What the composer should do with what is in the box.
 *
 * `message` is ordinary text and the only case that keeps the existing path —
 * echo, retry set and all. The other three are commands: `send` is the text that
 * goes to the pane, `note` is what the composer says about it afterwards, and
 * `hatch` asks for the button that opens the terminal beside that note.
 */
export type Plan =
  | { plan: 'message' }
  | { plan: 'command'; send: string; note: string; hatch: boolean }
  | { plan: 'refuse'; note: string };

/**
 * Everything up to the first **whitespace**, which is how both CLIs lex a
 * command — a line break ends a name as surely as a space does.
 */
function split(message: string): { name: string; args: string } {
  const at = message.search(/\s/);
  return at === -1
    ? { name: message, args: '' }
    : { name: message.slice(0, at), args: message.slice(at + 1).trim() };
}

/**
 * Whether a line is addressed to the CLI's own command box rather than to the
 * agent.
 *
 * Delivery is identical either way — one `input` frame, the same bytes, and the
 * CLI applies its own leading-slash rule to them — so this decides only which
 * feedback tether shows, never what the agent receives. With no delivery downside
 * to trade against, it **prefers prose wherever the line is ambiguous**: telling
 * someone "tether does not know this command" when they typed an ordinary
 * sentence about a file is the interface being confidently wrong about what they
 * did, while a real command read as prose still arrives as the same bytes and the
 * CLI still honours it.
 *
 * So three rules, each chosen because it cannot realistically be wrong:
 *
 *  - a leading `/`, the rule both CLIs' own input boxes apply;
 *  - **a command name carries no further `/`** — no command in either provider's
 *    set has one, while `/home/me/app.ts is broken, please fix` is a sentence
 *    about a path. A bare `/` fails this too, being no name at all: it is what a
 *    user has typed on the way to a command with the list showing under it, and
 *    sending it would only make the pane print `Unknown command: /`;
 *  - **one line.** A slash command is a single line in both CLIs, so a multi-line
 *    paste that happens to open with one is prose by the tie-break above.
 */
function isCommandLine(message: string): boolean {
  if (!message.startsWith('/') || /[\r\n]/.test(message)) return false;
  const { name } = split(message);
  return name.length > 1 && !name.slice(1).includes('/');
}

export function planSend(provider: string, message: string): Plan {
  if (!isCommandLine(message)) return { plan: 'message' };
  const { name, args } = split(message);
  const agent = providerLabel(provider);
  const command = commandsFor(provider).find((entry) => entry.name === name);

  if (command === undefined) {
    // Sent anyway: the table is not the authority on what a CLI accepts, and a
    // user's own custom command is exactly what it has never heard of. What is
    // said is only what tether can honestly claim — which is nothing about the
    // result. The second sentence is why Codex's leftover is worth mentioning.
    return {
      plan: 'command',
      send: message,
      note: `Sent ${message}. tether does not know this command, so it cannot say what it did — the terminal shows that, and shows the line still sitting in the box if the command was not recognised.`,
      hatch: true,
    };
  }

  if (command.noArgs === true && args !== '') {
    return {
      plan: 'refuse',
      note: `${agent} takes no argument on ${name} — with one it goes to the model as a prompt instead of running the command. Send ${name} on its own and answer the chooser it opens.`,
    };
  }

  const answers =
    args !== '' && command.withArgs !== undefined ? command.withArgs : command.answers;
  if (answers === 'picker') {
    return {
      plan: 'command',
      send: message,
      note: `Sent ${message}. It opens a chooser tether cannot show, so ${agent} is now waiting for a selection.`,
      hatch: true,
    };
  }
  if (answers === 'terminal') {
    return {
      plan: 'command',
      send: message,
      note: `Sent ${message}. ${agent} answers this one in the terminal only — nothing about it will appear here.`,
      hatch: true,
    };
  }
  return {
    plan: 'command',
    send: message,
    note: `Sent ${message}. ${agent} records this one, so its answer lands above.`,
    hatch: false,
  };
}

/**
 * The commands worth offering under a half-typed one, best match first.
 *
 * This is the discoverability half, and it is a prefix filter rather than an
 * autocomplete: the placeholder already says `/ commands` (`composerHint` in
 * `options.ts`), and what it cannot say is *which*. A bare `/` therefore matches
 * everything, which is the affordance the placeholder is pointing at.
 *
 * Capped, because this list is drawn over the conversation on a 360px phone and
 * a list longer than the screen is a list that covers the thing it is helping
 * with.
 */
export const MATCH_LIMIT = 6;

/**
 * The two words the list puts beside a command, and it says the one thing a user
 * cannot guess: whether tapping it will show them anything. `conversation` gets
 * nothing at all — that is the ordinary case and a badge on every row would make
 * the exceptions invisible.
 */
export function whereLabel(command: Command): string {
  if (command.answers === 'picker') return 'asks in terminal';
  if (command.answers === 'terminal') return 'terminal only';
  return '';
}

export function matchCommands(provider: string, message: string): readonly Command[] {
  // The same rule `planSend` routes on, so the list never appears under a line
  // that would be sent as prose — a pasted path included. A bare `/` is the one
  // exception, and it is the affordance the placeholder is pointing at.
  if (message !== '/' && !isCommandLine(message)) return [];
  const { name, args } = split(message);
  // Past the first space the user is writing an argument, not choosing a command.
  if (args !== '' || /\s$/.test(message)) return [];
  return commandsFor(provider)
    .filter((entry) => entry.name.startsWith(name))
    .slice(0, MATCH_LIMIT);
}
