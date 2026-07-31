#!/usr/bin/env bash
#
# tether installer.
#
#   curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash
#
# Clones the repo, checks the prerequisites that actually bite, builds, and puts
# `tether` on PATH. It installs no system package and runs no `sudo` without
# printing exactly what it would run and asking first; declining is a supported
# answer, and prints the commands so you can run them yourself.

# Arrays and [[ ]] below are bash-only, and `sh install.sh` would otherwise die
# on one of them with a syntax error naming a line rather than the cause. This
# has to come before `set -o pipefail`, which is itself not portable to every sh.
if [ -z "${BASH_VERSION:-}" ]; then
	printf 'error: this installer needs bash. Run it as: bash install.sh\n' >&2
	exit 1
fi

set -euo pipefail

REPO_URL="${TETHER_REPO_URL:-https://github.com/galawaydude/tether.git}"
DEFAULT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tether"
# uv, mise and the rest of the modern consensus land the command here, and on
# Debian and Ubuntu ~/.profile already puts it on PATH when it exists. It also
# never needs sudo, unlike npm's global prefix, which is a property of how Node
# was installed rather than a choice this script gets to make.
BIN_DIR="$HOME/.local/bin"

# tmux before 3.7 sizes a not-yet-created window through a NULL pointer, so under
# the `window-size manual` that tether.conf sets every detached `new-session`
# kills the server. Debian and Ubuntu ship 3.4, so a package manager reporting
# tmux as installed proves nothing. Same pinned release and checksum as
# .github/workflows/ci.yml, which builds it this way on every run.
TMUX_MIN_MAJOR=3
TMUX_MIN_MINOR=7
TMUX_VERSION=3.7b
TMUX_SHA256=87f2e99e3b685973f2ca002ffd6ed7e51a5744f7009daae5a15670b6d532db96

ASSUME_YES=0
TARGET_DIR=""
VERSION=""

die() {
	printf '\nerror: %s\n' "$1" >&2
	exit 1
}
step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

as_root() {
	if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

usage() {
	cat <<EOF
tether installer

Usage: install.sh [options]

  --dir <path>   Where to clone tether (default $DEFAULT_DIR)
  --yes          Do not prompt; accept the system packages this would install
  --self-test    Check this script's own version parsing and exit
  --help         This message

Environment:

  TETHER_VERSION   Release tag to install (default: the latest one)
EOF
}

# The tip of a branch is whatever landed minutes ago, half-landed changes
# included, so this installs a release instead — the highest vX.Y.Z tag the repo
# publishes. Anything else (v0.1.0-rc1, a branch name) is TETHER_VERSION's job.
latest_version() {
	git ls-remote --tags --refs "$REPO_URL" 2>/dev/null |
		sed 's#.*/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
}

# `tmux -V` prints "tmux 3.7b", "tmux 3.4" or "tmux next-3.8". Succeeds iff that
# version is at or above the floor.
tmux_version_ok() {
	local v="${1#tmux }" major minor
	v="${v#next-}"
	major="${v%%.*}"
	v="${v#*.}"
	minor="${v%%[!0-9]*}"
	[[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
	((major > TMUX_MIN_MAJOR || (major == TMUX_MIN_MAJOR && minor >= TMUX_MIN_MINOR)))
}

# `node -v` prints "v24.18.0"; $2 is the major read out of .nvmrc.
node_version_ok() {
	local major="${1#v}" want="$2"
	major="${major%%.*}"
	[[ $major =~ ^[0-9]+$ ]] || return 1
	((major >= want))
}

# The one definition of how to get a new enough tmux by hand. Printed both where
# the plan is declined and where there is no apt-get to build it with, which are
# the same instruction and must not be able to drift apart.
tmux_build_recipe() {
	note "  curl -sSfL -O https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
	note "  tar -xzf tmux-$TMUX_VERSION.tar.gz && cd tmux-$TMUX_VERSION"
	note "  ./configure && make && sudo make install"
}

# The port tether serves on, and the one Funnel is pointed at. Not an option:
# `tether serve --port` exists for someone who has a reason, and that someone is
# past what this script sets up.
PORT=8787

# Where a backgrounded `tether serve` writes. tether's own state directory, so
# uninstalling by the README's three paths takes it with everything else — this
# script invents no new location. The derivation is `stateDir()`'s, in
# server/src/db.ts, including that `TETHER_STATE_DIR` is the directory itself
# and only the XDG branch appends `tether`; the two must agree or the log lands
# beside the state rather than in it.
serve_log() {
	printf '%s/serve.log\n' "${TETHER_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/tether}"
}

# Whether something on tether's port answers *for this Host*. `-f` makes the
# guard's 403 a failure, which is the whole point: a plain `tether serve` allows
# loopback names only, so it answers a bare probe and refuses the Funnel name —
# the opaque 403 `--funnel` exists to prevent. Probing with the published name
# is what tells "tether is already serving" from "already serving, but not for
# this address".
serving_as() {
	curl -fsS -o /dev/null --max-time 5 -H "Host: $1" "http://127.0.0.1:$PORT/" 2>/dev/null
}

# Tailscale's backend state: `Running`, `NeedsLogin`, `Stopped`, `NoState`.
# Empty when tailscaled is not answering at all.
ts_state() {
	tailscale status --json 2>/dev/null |
		sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Whether this tailnet permits Funnel — the `funnel` node attribute, which
# appears as its own key in `Self.CapMap` and in the deprecated `Capabilities`
# list beside it. Advisory: this is the installer spending a sentence instead of
# a sudo. The enforcing check is tether's own, in
# server/src/machine/tailscale.ts, and it is the one with the tests.
ts_funnel_allowed() {
	tailscale status --json 2>/dev/null | grep -q '"funnel"'
}

# This machine's MagicDNS name — the public address Funnel serves it under, and
# the Host the probe below asks tether to accept. Read from the same
# `tailscale status --json` the two checks above read, and from the same field
# server/src/machine/tailscale.ts reads: `Self.DNSName`, minus its trailing dot.
# Deliberately not scraped out of `tailscale funnel status`, whose
# `https://<name> (Funnel on)` line is human-readable output another tool owns
# and is free to reword — the structured source is already in hand here.
# `--peers=false` is what makes the match unambiguous: it leaves exactly one
# `DNSName` in the payload, Self's, where a full status carries one per peer.
ts_dns_name() {
	tailscale status --json --peers=false 2>/dev/null |
		sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
		head -n 1 | sed 's/\.$//'
}

# Whether Funnel already points at tether's port, which is what makes a re-run
# skip the sudo rather than repeat it.
funnel_armed() {
	tailscale funnel status 2>/dev/null | grep -q "proxy http://127.0.0.1:$PORT\$"
}

# Which of the three things there is to say about PATH is true, decided from
# strings alone so the self-test can ask it. `first` is the symlink this script
# wrote being what runs, `later` is it being on PATH behind something else, and
# `absent` is it not being on PATH at all — which is also the answer when nothing
# resolved, since that is the same message. The `:` on both sides is what keeps
# /home/u/.local/binx from matching /home/u/.local/bin.
path_message_state() {
	local bin_dir=$1 resolved=$2 path=$3
	if [ -z "$resolved" ]; then
		printf 'absent\n'
	elif [ "$resolved" = "$bin_dir/tether" ]; then
		printf 'first\n'
	else
		case ":$path:" in
		*":$bin_dir:"*) printf 'later\n' ;;
		*) printf 'absent\n' ;;
		esac
	fi
}

# curl | bash leaves stdin holding the script, so a prompt has to come from the
# terminal itself. No terminal and no --yes means no consent, which is a no.
confirm() {
	local reply
	if ((ASSUME_YES)); then return 0; fi
	# The group scopes the 2>/dev/null to this one open — `exec 3<> … 2>/dev/null`
	# would silence the whole script's stderr for good — while still leaving fd 3
	# open in this shell, which a subshell would not.
	if ! { exec 3<>/dev/tty; } 2>/dev/null; then
		note "There is no terminal to ask on. Re-run with --yes to accept the above."
		return 1
	fi
	printf '\n%s [y/N] ' "$1" >&3
	read -r reply <&3 || reply=""
	exec 3>&-
	[[ $reply == [yY] || $reply == [yY][eE][sS] ]]
}

self_test() {
	local fails=0 want got bin=/home/u/.local/bin
	check() {
		want=$1
		shift
		if "$@"; then got=0; else got=1; fi
		if [ "$got" != "$want" ]; then
			printf 'FAIL (want %s, got %s): %s\n' "$want" "$got" "$*"
			fails=1
		fi
	}
	check 0 tmux_version_ok 'tmux 3.7b'
	check 0 tmux_version_ok 'tmux 3.7'
	check 0 tmux_version_ok 'tmux 3.10'
	check 0 tmux_version_ok 'tmux 4.0'
	check 0 tmux_version_ok 'tmux next-3.8'
	check 1 tmux_version_ok 'tmux 3.4'
	check 1 tmux_version_ok 'tmux 3.6a'
	check 1 tmux_version_ok 'tmux 2.9'
	check 1 tmux_version_ok 'tmux unknown'
	check 1 tmux_version_ok ''
	check 0 node_version_ok 'v24.18.0' 24
	check 0 node_version_ok 'v25.0.0' 24
	check 1 node_version_ok 'v22.14.0' 24
	check 1 node_version_ok 'not a version' 24
	check_out() {
		want=$1
		shift
		got=$("$@" || true)
		if [ "$got" != "$want" ]; then
			printf 'FAIL (want %s, got %s): %s\n' "$want" "$got" "$*"
			fails=1
		fi
	}
	check_out first path_message_state "$bin" "$bin/tether" "$bin:/usr/bin"
	check_out later path_message_state "$bin" /home/u/.nvm/bin/tether "/home/u/.nvm/bin:$bin:/usr/bin"
	check_out absent path_message_state "$bin" /home/u/.nvm/bin/tether /home/u/.nvm/bin:/usr/bin
	check_out absent path_message_state "$bin" '' /usr/bin
	check_out absent path_message_state "$bin" /usr/bin/tether /home/u/.local/binx:/usr/bin
	check_out later path_message_state "$bin" /usr/bin/tether "/usr/bin:$bin"
	check_out later path_message_state "$bin" /usr/bin/tether "$bin"
	if ((fails)); then die 'self-test failed'; fi
	printf 'self-test ok\n'
}

# Reaching tether from somewhere that is not this machine, which is the whole
# point of the product and the part that exposes it. Tailscale Funnel is what
# this sets up: the only option where the phone needs nothing installed, and the
# only one that puts the login page on the public internet. Both halves get said,
# in that order, before anything is done.
#
# Three preconditions, each its own answer because each has a different thing for
# the user to do and two of them cannot be automated at all. Returning non-zero
# from anywhere in here is a supported outcome, not an error: tether is installed
# and works on loopback, and main() prints that instead of the link.
#
# It changes things outside tether's own directory, so the file's contract holds
# here exactly as it does above: the exact commands on screen, a yes, and
# declining prints them and stops. Re-running skips whatever is already true.
reachability() {
	local state url host log ts_installer

	step "Reaching tether from your phone"
	note "This sets up Tailscale Funnel: a public HTTPS address for this machine,"
	note "reachable from a device that has never heard of Tailscale."
	note ""
	note "Anyone who opens that address and knows your tether password gets a shell"
	note "on this machine. There is one account and one password, and no read-only"
	note "mode. The address is not a secret either: the certificate Funnel gets for"
	note "it is published in the public certificate-transparency logs, so treat the"
	note "name as known rather than as a second factor."
	note ""
	note "README.md's \"Reaching it from your phone\" has the two narrower options — a"
	note "private tailnet with nothing public, and an SSH tunnel."

	# 1 ── installed?
	if ! command -v tailscale >/dev/null 2>&1; then
		step "Tailscale is not installed"
		if [ "$OS" = macos ]; then
			# Not offered rather than offered badly: on macOS Tailscale is the App
			# Store app or a Homebrew cask, they behave differently, and which one
			# someone wants is not this script's guess to make.
			note "On macOS this script does not install it for you — it is the App Store"
			note "app or a Homebrew cask, and which of those you want is yours to pick:"
			note ""
			note "  brew install --cask tailscale"
			note "  https://tailscale.com/download"
			note ""
			note "Install it, then re-run this script; it picks up from here."
			return 1
		fi
		note "Tailscale publishes its own install script. This is that script:"
		note ""
		note "  curl -fsSL https://tailscale.com/install.sh | sh"
		note ""
		note "It installs a system package and uses sudo, and it is Tailscale's"
		note "script rather than tether's. It is fetched to a file and run from"
		note "there rather than piped, so that it cannot eat this script's own stdin."
		if ! confirm "Run it?"; then
			step "Tailscale was not installed."
			note "Run the command above yourself and re-run this script."
			return 1
		fi
		step "Installing Tailscale"
		ts_installer=$(mktemp)
		# Same rules as the tmux tarball above: -L follows redirects and
		# --proto '=https' is what keeps one of them landing on plain http.
		curl -sSfL --proto '=https' -o "$ts_installer" https://tailscale.com/install.sh ||
			die "could not download https://tailscale.com/install.sh"
		sh "$ts_installer" </dev/null || {
			rm -f "$ts_installer"
			note "Tailscale's installer failed. Run it yourself and re-run this script."
			return 1
		}
		rm -f "$ts_installer"
		hash -r
		command -v tailscale >/dev/null 2>&1 || {
			note "Tailscale's installer finished, but \`tailscale\` is not on PATH."
			return 1
		}
	fi
	note "$(tailscale version 2>/dev/null | head -n 1)"

	# 2 ── logged in? Nothing below can be known until it is: a logged-out node
	# reports no capabilities at all, so asking about Funnel first would tell
	# someone to edit their access controls when they need to sign in.
	state=$(ts_state)
	if [ "$state" != Running ]; then
		step "Tailscale is installed but not signed in (state: ${state:-no answer from tailscaled})"
		note "This is a step that cannot be automated and must not be faked: signing"
		note "in happens in a browser, against your own Tailscale account."
		note ""
		note "  sudo tailscale up"
		note ""
		note "That prints a URL. Open it, sign in, and it returns on its own."
		if ! confirm "Run it and wait?"; then
			step "Tailscale was not signed in."
			note "Run the command above yourself and re-run this script."
			return 1
		fi
		step "Waiting for you to finish signing in in your browser"
		as_root tailscale up || {
			note "\`tailscale up\` did not finish. Run it yourself and re-run this script."
			return 1
		}
		state=$(ts_state)
		[ "$state" = Running ] || {
			note "Tailscale reports state \"$state\". Re-run this script once it is Running."
			return 1
		}
	fi

	# 3 ── permitted on the tailnet? A policy change rather than a command, so
	# there is nothing to offer to run — only the place to make it.
	if ! ts_funnel_allowed; then
		step "Funnel is not enabled for this tailnet"
		note "The last one-time human step, and this one is a policy change rather"
		note "than a command: the \"funnel\" node attribute has to be in your tailnet's"
		note "access controls, which is a thing only an admin of it can add."
		note ""
		note "  https://login.tailscale.com/admin/acls/file"
		note ""
		note "What to add is written up at https://tailscale.com/s/no-funnel"
		note ""
		note "Add it, then re-run this script."
		return 1
	fi

	# 4 ── does this machine have a name to be published under? Tailscale's own
	# answer, asked before anything is armed, because it is what the address is
	# and there is nothing to publish without it.
	host=$(ts_dns_name)
	[ -n "$host" ] || {
		step "Tailscale reports no name for this machine"
		note "A public address is a MagicDNS name, and this tailnet is not giving"
		note "this machine one. Turn MagicDNS on once at"
		note ""
		note "  https://login.tailscale.com/admin/dns"
		note ""
		note "then re-run this script."
		return 1
	}
	url="https://$host"

	# The sudo all of that was leading to — skipped whole when Funnel already
	# points at the port, which is what makes a second run cheap and quiet.
	if funnel_armed; then
		note "Funnel already points at 127.0.0.1:$PORT."
	else
		step "This publishes this machine on the internet"
		note "- sudo tailscale funnel --yes --bg $PORT"
		note ""
		note "It stays on across reboots until you turn it off:"
		note ""
		note "  sudo tailscale funnel --bg off"
		if ! confirm "Publish it?"; then
			step "Funnel was not turned on."
			note "tether is installed and works on loopback. Turn Funnel on whenever"
			note "you want to, with the command above."
			return 1
		fi
		step "Turning Funnel on"
		# `--yes` because Tailscale asks its own confirmation before publishing,
		# and with no controlling terminal it waits for an answer that can never
		# come — which under `curl | bash` or `--yes` is a hang, not a failure.
		# The exact command is on screen above and has already been agreed to, so
		# this declines to ask a question the user has just answered.
		as_root tailscale funnel --yes --bg "$PORT" || {
			note "\`tailscale funnel\` failed. tether is installed and works on loopback."
			return 1
		}
	fi

	# Before tether starts and therefore before the address is answerable at all.
	# `--if-unset` is what makes a re-run leave a working password alone rather
	# than asking for it again.
	step "Setting tether's password"
	note "One account, one password. It is the only thing between that public"
	note "address and a shell on this machine, so make it a real one."
	[ -e /dev/tty ] || {
		note "There is no terminal to prompt on. Run \`tether set-password\` yourself,"
		note "then \`tether serve --funnel\`."
		return 1
	}
	"$BIN_DIR/tether" set-password --if-unset </dev/tty || return 1

	log=$(serve_log)
	if serving_as "$host"; then
		note "tether is already serving on 127.0.0.1:$PORT for $host; leaving it as it is."
	elif curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null; then
		# Answers on loopback, refuses the published name: a `tether serve`
		# started without --funnel. Printing the address now would hand over a
		# link that 403s on every request, so this stops instead of succeeding.
		step "Something else is already serving on 127.0.0.1:$PORT"
		note "It answers on loopback but refuses $host, so it was not started"
		note "with --funnel and every request through Funnel would fail with a 403."
		note "Stop it, then start tether again:"
		note ""
		note "  tether serve --funnel --port $PORT"
		return 1
	else
		step "Starting tether"
		# 0700 to match the directory tether itself creates for its state; -m
		# applies only where this is the thing that creates it.
		mkdir -p -m 700 "$(dirname "$log")"
		# Backgrounded and detached from this script, which is about to exit —
		# and from its stdin, which under `curl | bash` is the script itself.
		# `--port` because this script's PORT is what Funnel was armed at, so it
		# is the authority rather than `serve`'s own default.
		nohup "$BIN_DIR/tether" serve --funnel --port "$PORT" >>"$log" 2>&1 </dev/null &
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			serving_as "$host" && break
			sleep 1
		done
		serving_as "$host" || {
			note "tether did not come up on $host. What it printed is in $log."
			return 1
		}
		note "Running in the background; its output goes to $log"
	fi

	step "Open this on your phone"
	note ""
	note "  $url"
	note ""
	note "Log in with the password you just set. That address is on the public"
	note "internet and reaching it is equivalent to a shell on this machine."
	note ""
	note "  sudo tailscale funnel --bg off    # take it down again"
	note "  tailscale funnel status           # what is published right now"
	return 0
}

# Everything below runs inside main() so that bash reads this whole script
# before executing any of it. Piped from curl, the script *is* stdin, and a child
# that reads stdin — apt-get does — otherwise swallows the rest of it and the run
# ends early, successfully, having done half the job.
main() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--dir)
			TARGET_DIR="${2:-}"
			[ -n "$TARGET_DIR" ] || die '--dir needs a path'
			shift 2
			;;
		--yes | -y)
			ASSUME_YES=1
			shift
			;;
		--self-test)
			self_test
			exit 0
			;;
		--help | -h)
			usage
			exit 0
			;;
		*) die "unknown option: $1 (try --help)" ;;
		esac
	done

	case "$(uname -s)" in
	Linux) OS=linux ;;
	Darwin) OS=macos ;;
	*) die "unsupported platform: $(uname -s). tether needs Linux or macOS." ;;
	esac

	# All of them, so a machine missing two takes one round trip rather than two.
	missing=()
	for tool in git curl; do
		command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
	done
	((${#missing[@]} == 0)) ||
		die "required but not installed: ${missing[*]}"

	# Where the tether command ends up, asked before anything at all is done rather
	# than at the last step, so a destination that cannot be written to costs a
	# sentence rather than a clone, a sudo, an apt install, a tmux build and an
	# `npm ci` first. Tested by writing: permission bits do not settle it on every
	# filesystem, and a read-only mount reports the same bits as a writable one.
	# The directory itself is not created here — it is outside tether's own
	# directory, and a run declined at the prompt below must leave nothing behind —
	# so what is probed is the deepest part of the path that already exists.
	bin_probe_dir="$BIN_DIR"
	while [ ! -d "$bin_probe_dir" ]; do
		bin_probe_dir=$(dirname "$bin_probe_dir")
	done
	probe="$bin_probe_dir/.tether-write-test.$$"
	if touch "$probe" 2>/dev/null; then
		rm -f "$probe"
	else
		die "$bin_probe_dir is not writable, and $BIN_DIR is where the tether command goes. Fix its permissions and re-run."
	fi

	# Running ./install.sh from inside a checkout installs *that* checkout, rather
	# than cloning a second copy and leaving `tether` pointing at whichever won. It
	# is also the one case that must not touch git: that checkout is being worked on.
	FROM_CHECKOUT=0
	if [ -z "$TARGET_DIR" ] && [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
		here=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
		if [ -f "$here/server/package.json" ] && [ -e "$here/.git" ]; then
			TARGET_DIR="$here"
			FROM_CHECKOUT=1
		fi
	fi

	if [ -z "$TARGET_DIR" ]; then
		TARGET_DIR="$DEFAULT_DIR"
	fi

	# A checkout being worked on is at whatever ref its owner put it at; asking the
	# network which release is current is neither wanted nor used there.
	if ((FROM_CHECKOUT == 0)); then
		# `|| true` because under `set -e` a failing substitution in a plain
		# assignment exits the script there and then — offline, or on a repo with no
		# release tag, that is a silent exit 1 with the message below never printed.
		VERSION="${TETHER_VERSION:-$(latest_version || true)}"
		[ -n "$VERSION" ] ||
			die "could not work out the latest tether release from $REPO_URL. Set TETHER_VERSION=vX.Y.Z and re-run."
	fi

	if [ ! -e "$TARGET_DIR" ]; then
		step "Cloning tether $VERSION into $TARGET_DIR"
		# Fail rather than hang on a credential prompt if this ever stops being public.
		GIT_TERMINAL_PROMPT=0 git clone --branch "$VERSION" --depth 1 "$REPO_URL" "$TARGET_DIR" ||
			die "could not clone $VERSION from $REPO_URL. If it is private, clone it yourself (gh repo clone galawaydude/tether \"$TARGET_DIR\") and re-run this script."
	elif [ ! -e "$TARGET_DIR/.git" ]; then
		die "$TARGET_DIR exists and is not a git checkout. Move it, or pass --dir <path>."
	elif ((FROM_CHECKOUT)); then
		step "Installing this checkout: $TARGET_DIR"
	else
		# Not a pull: the clone above is shallow and on a tag rather than a branch,
		# so there is no upstream to fast-forward along. Fetching the one tag keeps it
		# shallow, and re-running the installer is how tether is upgraded.
		step "Updating $TARGET_DIR to $VERSION"
		if ! GIT_TERMINAL_PROMPT=0 git -C "$TARGET_DIR" fetch --depth 1 --force origin \
			"refs/tags/$VERSION:refs/tags/$VERSION" ||
			! git -C "$TARGET_DIR" checkout --quiet "$VERSION"; then
			note "could not check out $VERSION — leaving your checkout as it is and building that."
		fi
	fi

	cd "$TARGET_DIR"
	# The symlink below points at this path, so a relative --dir must not survive.
	TARGET_DIR="$PWD"

	NODE_MAJOR=$(sed 's/^v//; s/\..*//' .nvmrc)
	command -v node >/dev/null 2>&1 ||
		die "Node $NODE_MAJOR or newer is required. Install it from https://nodejs.org, or with nvm: nvm install $(cat .nvmrc)"
	node_version_ok "$(node -v)" "$NODE_MAJOR" ||
		die "Node $NODE_MAJOR or newer is required; found $(node -v). With nvm: nvm install $(cat .nvmrc)"

	# What, if anything, needs installing is decided before anything is installed,
	# so the whole cost is on screen in one place, once, before the one prompt.
	step "Checking prerequisites"
	note "node $(node -v)"

	if ! command -v tmux >/dev/null 2>&1; then
		tmux_state=missing
		note "tmux: not installed (tether needs $TMUX_MIN_MAJOR.$TMUX_MIN_MINOR or newer)"
	elif tmux_version_ok "$(tmux -V)"; then
		tmux_state=ok
		note "$(tmux -V)"
	else
		tmux_state=old
		note "$(tmux -V): too old, tether needs $TMUX_MIN_MAJOR.$TMUX_MIN_MINOR or newer"
	fi

	# node-pty ships prebuilds for darwin and win32 only, so a Linux `npm ci`
	# compiles it and a machine with no toolchain gets no PTY at all.
	need_toolchain=0
	if [ "$OS" = linux ]; then
		for tool in cc c++ make python3; do
			command -v "$tool" >/dev/null 2>&1 || need_toolchain=1
		done
		if ((need_toolchain)); then
			note "C++ toolchain: missing (node-pty is compiled from source on Linux)"
		fi
	fi

	apt_packages=()
	brew_cmd=()
	plan=()
	if [ "$OS" = linux ]; then
		if ((need_toolchain)); then
			apt_packages+=(build-essential python3)
		fi
		if [ "$tmux_state" != ok ]; then
			if ((need_toolchain == 0)); then apt_packages+=(build-essential); fi
			apt_packages+=(bison libevent-dev libncurses-dev pkg-config)
		fi
		if ((${#apt_packages[@]})); then
			# Before the plan rather than before the install: a plan quoting apt-get
			# to a machine that has no apt-get asks for consent to something that
			# cannot happen, and tells the user so only once they have said yes.
			# What it says instead has to be a way out rather than a loop — these
			# package names are re-derived from the same state on every run, so
			# "install the equivalents and re-run" alone lands back here unchanged.
			if ! command -v apt-get >/dev/null 2>&1; then
				step "This script installs system packages with apt-get, and there is none here"
				note "It installs them no other way, and does not know your package manager's"
				note "names for them. In Debian's names, what it would have installed:"
				note ""
				note "  ${apt_packages[*]}"
				note ""
				if ((need_toolchain)); then
					note "cc, c++, make and python3 have to be on PATH before the build: node-pty"
					note "ships no Linux prebuild and is compiled here. That half is your own"
					note "package manager's, and this script cannot do it for you."
					note ""
				fi
				if [ "$tmux_state" != ok ]; then
					note "tmux is the half this script can be exact about — the packages listed"
					note "are what building it needs, under whatever names your distribution"
					note "gives them. This is how it would have built $TMUX_VERSION:"
					note ""
					tmux_build_recipe
					note ""
				fi
				die "install what is missing with your own package manager, then re-run this script."
			fi
			plan+=("install these packages: ${apt_packages[*]}")
		fi
		if [ "$tmux_state" != ok ]; then
			plan+=("build tmux $TMUX_VERSION from source and install it to /usr/local/bin")
		fi
	elif [ "$tmux_state" != ok ]; then
		command -v brew >/dev/null 2>&1 ||
			die "tmux $TMUX_MIN_MAJOR.$TMUX_MIN_MINOR or newer is required and Homebrew is not installed. Install Homebrew from https://brew.sh and re-run, or build tmux $TMUX_VERSION yourself."
		# `brew upgrade` refuses a formula Homebrew does not have installed, and the
		# too-old tmux on PATH is as likely to be MacPorts', Nix's or a hand-built one.
		# So the choice is Homebrew's own answer about what it owns, not an inference
		# from what PATH reports. Decided once here: the plan, the decline path and
		# what actually runs are all this one array.
		if brew list --formula tmux >/dev/null 2>&1; then
			brew_cmd=(brew upgrade tmux)
		else
			brew_cmd=(brew install tmux)
		fi
		plan+=("${brew_cmd[*]}")
	fi

	if ((${#plan[@]})); then
		step "This needs to change something outside tether's own directory"
		for line in "${plan[@]}"; do note "- $line"; done
		# "Installs to /usr/local/bin" is only "leaves yours alone" when yours is
		# somewhere else. If it is not, this overwrites a working tmux, and that is
		# the user's call to make rather than a detail to leave off the plan.
		if [ "$OS" = linux ] && [ "$tmux_state" = old ]; then
			note ""
			case "$(command -v tmux)" in
			/usr/local/bin/*)
				note "This REPLACES the tmux already at $(command -v tmux)."
				;;
			*)
				note "Your existing tmux at $(command -v tmux) is left exactly where it is."
				note "tmux $TMUX_VERSION goes to /usr/local/bin. Which of the two your PATH"
				note "then runs is checked after the build, and named here if it is the old one."
				;;
			esac
		fi
		if ! confirm "Proceed?"; then
			step "Nothing was installed."
			note "Run these yourself and re-run this script, or re-run it with --yes:"
			note ""
			if ((${#apt_packages[@]})); then
				note "  sudo apt-get update && sudo apt-get install -y ${apt_packages[*]}"
			fi
			if [ "$OS" = linux ] && [ "$tmux_state" != ok ]; then
				tmux_build_recipe
			elif ((${#brew_cmd[@]})); then
				note "  ${brew_cmd[*]}"
			fi
			exit 1
		fi
	fi

	if ((${#apt_packages[@]})); then
		step "Installing system packages"
		as_root apt-get update </dev/null
		as_root apt-get install -y "${apt_packages[@]}" </dev/null
	fi

	if [ "$tmux_state" != ok ]; then
		if [ "$OS" = macos ]; then
			step "Installing tmux with Homebrew"
			"${brew_cmd[@]}" ||
				die "Homebrew failed (${brew_cmd[*]}). Run it yourself and re-run this script, or build tmux $TMUX_VERSION from source."
		else
			step "Building tmux $TMUX_VERSION"
			build=$(mktemp -d)
			trap 'rm -rf "$build"' EXIT
			tarball="tmux-$TMUX_VERSION.tar.gz"
			# -L follows redirects, and --proto '=https' is what keeps one of them
			# from landing on plain http; --proto-redir cannot widen it back.
			curl -sSfL --proto '=https' -o "$build/$tarball" \
				"https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/$tarball"
			echo "$TMUX_SHA256  $build/$tarball" | sha256sum -c -
			tar -xzf "$build/$tarball" -C "$build"
			(cd "$build/tmux-$TMUX_VERSION" && ./configure && make -j"$(nproc)" && as_root make install)
		fi
		hash -r
		tmux_version_ok "$(tmux -V)" ||
			die "installed tmux $TMUX_VERSION, but $(command -v tmux) still reports $(tmux -V). Something earlier on PATH is shadowing it."
		note "$(tmux -V)"
	fi

	# `npm ci` runs each workspace's `prepare`, which is what builds server/dist/cli.js
	# — the file server/package.json declares as the `tether` bin — and web/dist.
	step "Installing dependencies and building"
	npm ci

	step "Linking the tether command into $BIN_DIR"
	# A symlink rather than `npm link`, which writes into npm's *global prefix* —
	# root-owned whenever Node came from a distro package or a tarball, so it is an
	# EACCES with a Node stack trace for an ordinary user, at the last step, after
	# every expensive consented thing above has already been spent. `dist/cli.js`
	# carries its own shebang and exec bit (server's `build` ends in `chmod +x`),
	# and Node resolves a symlink to its real path, so the checkout's own
	# node_modules is found exactly as it was under `npm link`.
	mkdir -p "$BIN_DIR" ||
		die "could not create $BIN_DIR, which is where the tether command goes."
	ln -sf "$TARGET_DIR/server/dist/cli.js" "$BIN_DIR/tether"

	hash -r
	# What `tether` resolves to need not be the symlink just written: an install
	# from before this script used ~/.local/bin left one in npm's global prefix,
	# which nvm, fnm, volta and asdf all put ahead of it on PATH. `-ef` rather than
	# a string compare, so a leftover pointing at *this* checkout — which runs the
	# right thing — is not reported as a different install.
	resolved=$(command -v tether || true)
	if [ -n "$resolved" ] && [ "$resolved" -ef "$BIN_DIR/tether" ]; then
		resolved="$BIN_DIR/tether"
	fi
	case "$(path_message_state "$BIN_DIR" "$resolved" "$PATH")" in
	later)
		step "tether is installed, but a different one is what runs"
		note "This script wrote $BIN_DIR/tether."
		note "$BIN_DIR is on your PATH, but $resolved comes before it"
		note "and is another file. A previous install of tether used npm link, which is"
		note "the likely source. Remove it (npm unlink -g @tether/server, or delete that"
		note "file), or move $BIN_DIR ahead of it on your PATH."
		note ""
		note "This script does not remove a command it did not create."
		exit 1
		;;
	absent)
		step "tether is installed, but not on your PATH"
		note "It is at $BIN_DIR/tether. Add this line to your shell's startup file:"
		note ""
		note "  export PATH=\"$BIN_DIR:\$PATH\""
		note ""
		if [ -n "$resolved" ]; then
			note "Until then \`tether\` runs $resolved, which is another"
			note "file — most likely a previous install that used npm link. The line above"
			note "puts $BIN_DIR ahead of it."
			note ""
		fi
		note "This script does not edit shell startup files."
		exit 1
		;;
	esac

	step "Done — tether is at $resolved"

	# Everything above installed tether; this reaches it from your phone. A no
	# anywhere inside it leaves a working loopback install, which is what the
	# fallback below is: not an error path, the narrower of two good outcomes.
	if reachability; then
		return 0
	fi

	step "tether is installed, and reachable on this machine"
	cat <<-EOF

		Next, in a terminal on this machine:

		  tether set-password    # there is one account, and it is never defaulted
		  tether serve           # binds 127.0.0.1:$PORT

		Anyone who can reach that address and knows that password has a shell on
		this machine. README.md's "Reaching it from your phone" covers the ways to
		reach it from somewhere else — Tailscale Funnel, a private tailnet, or an
		SSH tunnel — and "Access and security" is worth reading before you pick one.

		Re-running this script picks the Funnel setup up from wherever it stopped.
	EOF
}

main "$@"
