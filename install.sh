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
	local fails=0 want got
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
	if ((fails)); then die 'self-test failed'; fi
	printf 'self-test ok\n'
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
	mkdir -p "$BIN_DIR" 2>/dev/null ||
		die "could not create $BIN_DIR, which is where the tether command goes."
	probe="$BIN_DIR/.tether-write-test.$$"
	if touch "$probe" 2>/dev/null; then
		rm -f "$probe"
	else
		die "$BIN_DIR is not writable, and that is where the tether command goes. Fix its permissions and re-run."
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
		VERSION="${TETHER_VERSION:-$(latest_version)}"
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
				note "/usr/local/bin comes before it on PATH, so tmux $TMUX_VERSION is what runs."
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
				note "  curl -sSfL -O https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
				note "  tar -xzf tmux-$TMUX_VERSION.tar.gz && cd tmux-$TMUX_VERSION"
				note "  ./configure && make && sudo make install"
			elif ((${#brew_cmd[@]})); then
				note "  ${brew_cmd[*]}"
			fi
			exit 1
		fi
	fi

	if ((${#apt_packages[@]})); then
		command -v apt-get >/dev/null 2>&1 ||
			die "no apt-get on this system. Install the equivalents of ${apt_packages[*]} with your package manager and re-run."
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
	ln -sf "$TARGET_DIR/server/dist/cli.js" "$BIN_DIR/tether"

	hash -r
	if ! command -v tether >/dev/null 2>&1; then
		step "tether is installed, but not on your PATH"
		note "It is at $BIN_DIR/tether. Add this line to your shell's startup file:"
		note ""
		note "  export PATH=\"$BIN_DIR:\$PATH\""
		note ""
		note "On Debian and Ubuntu ~/.profile already adds that directory when it"
		note "exists — it did not exist when you logged in, so logging out and back"
		note "in is enough on its own."
		note ""
		note "This script does not edit shell startup files."
		exit 1
	fi

	step "Done — tether is at $(command -v tether)"
	cat <<-'EOF'

		Next, in a terminal on this machine:

		  tether set-password    # there is one account, and it is never defaulted
		  tether serve           # binds 127.0.0.1:8787

		Anyone who can reach that address and knows that password has a shell on
		this machine. README.md's "Access and security" section is worth reading
		before you put tether anywhere but loopback.
	EOF
}

main "$@"
