#!/usr/bin/env bash
#
# tether installer.
#
#   curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash
#
# Clones the repo, checks the prerequisites that actually bite, builds, and puts
# `tether` on PATH. It installs no system package, writes no user service and
# runs no `sudo` without printing the exact bytes/commands and asking first;
# declining is a supported answer, and leaves the narrower setup working.

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
# The viewer-side contract. `public` is Tailscale Funnel: Tailscale runs only on
# this host and everyone else uses an ordinary HTTPS browser. `local` skips all
# remote setup without making the successful tether install an error.
ACCESS=public

# Tailscale recommends its signed Standalone system-extension package on macOS.
# The stable alias redirects to the current version and `/usr/sbin/installer`
# verifies the package signature before changing the machine.
TAILSCALE_MACOS_PKG=https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg
SERVICE_LABEL=dev.tether.server

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
  --access <mode> Remote access: public (browser-only Funnel, default) or local
  --yes          Do not prompt; accept the system packages and public access
                  changes this would make
  --self-test    Check the version parsing, PATH, Funnel probes and TETHER_VERSION
                 checkout moves, and exit
  --help         This message

Environment:

  TETHER_VERSION   Release tag, or a branch to test, to install
                   (default: the latest release tag)
EOF
}

# The tip of a branch is whatever landed minutes ago, half-landed changes
# included, so this installs a release instead — the highest vX.Y.Z tag the repo
# publishes. Anything else (v0.1.0-rc1, a branch name) is TETHER_VERSION's job.
latest_version() {
	git ls-remote --tags --refs "$REPO_URL" 2>/dev/null |
		sed 's#.*/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1
}

# Move an existing install to whatever TETHER_VERSION names. Not a pull: the
# clone below is shallow and detached, so there is no upstream branch to
# fast-forward along — and it holds exactly one ref, so `git checkout <anything
# else>` fails with "did not match any file(s) known to git" no matter how new
# the ref is. Fetching by name and checking out FETCH_HEAD is what makes a newer
# tag and a branch both work without giving up the shallow clone's speed.
#
# The tag refspec is tried first because it is the one that leaves a local tag
# behind, so `git -C <dir> describe` still names the release that is installed.
# A branch — how an unreleased change gets tested — has no such refspec and is
# the fallback; its stderr is what gets shown, since a name that is neither is
# the one this cannot do anything about.
update_checkout() {
	local dir=$1 ref=$2
	GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --depth 1 --force origin \
		"refs/tags/$ref:refs/tags/$ref" 2>/dev/null ||
		GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --depth 1 --force origin "$ref" ||
		return 1
	git -C "$dir" checkout --quiet --force FETCH_HEAD
}

# `tmux -V` prints "tmux 3.7b", "tmux 3.4" or "tmux next-3.8". Succeeds iff that
# version is at or above the floor. A string it cannot parse — and an empty one —
# fails, which is the safe direction: the plan then offers to build tmux, and the
# check after the build is what catches a PATH still running the old one.
tmux_version_ok() {
	local v="${1#tmux }" major minor
	v="${v#next-}"
	major="${v%%.*}"
	v="${v#*.}"
	minor="${v%%[!0-9]*}"
	[[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
	((major > TMUX_MIN_MAJOR || (major == TMUX_MIN_MAJOR && minor >= TMUX_MIN_MINOR)))
}

# `node -v` prints "v24.18.0"; $2 is the major read out of .nvmrc. Unparseable
# fails, and there is no over-install to pay for it: the caller dies quoting what
# it found, which is a better message than a build that fails later.
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
#
# A failure means only "not answering for this Host" — nothing there, a 403, or
# a timeout alike. That is ambiguous on its own, so the caller never acts on it
# alone: it asks the bare loopback probe next, and the two answers together are
# what separate "nothing is running" from "something is, without --funnel".
serving_as() {
	curl -fsS -o /dev/null --max-time 5 -H "Host: $1" "http://127.0.0.1:$PORT/" 2>/dev/null
}

# The one way this script reads Tailscale, and it is the structured document
# rather than any of the human-readable output the same binary prints:
# `tailscale status --json`, which server/src/machine/tailscale.ts reads too.
# **Always `--peers=false`.** Every question below is about *this* node, and a
# full status serialises the whole tailnet — a `DNSName` and a capability set
# per peer — so a match found anywhere in that document is not an answer about
# Self. With the flag exactly one of each is in the payload and the matches
# cannot be ambiguous; it is also the difference between ~3 KB and megabytes.
# A fourth reader added here inherits the flag by using this.
#
# Spawned **once** per run, and the readers below are handed the document rather
# than each asking for their own. Three spawns were three independent chances of
# getting nothing back, and two of them turned that silence into a confident
# instruction to go and change a tailnet policy. Taking it as an argument is
# also what lets --self-test drive them.
ts_status() {
	tailscale status --json --peers=false 2>/dev/null
}

# Whether that document is a status reply at all. Empty is the ordinary shape of
# "tailscaled did not answer" — `tailscale status` exits non-zero and prints
# nothing to stdout — and the `2>/dev/null` above is what would otherwise let it
# be read as one of the answers below rather than as no answer.
ts_readable() {
	case "$1" in *'"BackendState"'*) return 0 ;; *) return 1 ;; esac
}

# Tailscale's backend state: `Running`, `NeedsLogin`, `Stopped`, `NoState`.
# Empty only for a document ts_readable has already rejected.
ts_state() {
	printf '%s' "$1" |
		sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# `yes`, `no` or `unknown` — and **`unknown` is not `no`**, which is the whole of
# this function. What says a tailnet permits Funnel is the `funnel` node
# attribute, which a node it applies to carries as its own key in `Self.CapMap`
# and in the deprecated `Capabilities` list beside it. Matched as a substring,
# which is exact enough *because* of `--peers=false`: Self's is then the only
# capability set in the document.
#
# The absent case is what this is for. A capability set without `funnel` in it
# is a real `no`. **No capability set at all** is not: it is a node that did not
# report one, and it says nothing whatever about the tailnet's access controls —
# so answering `no` there sends someone to add an attribute their policy already
# has, which is a dead end at the one step of this script that has no command to
# offer. Advisory either way: the enforcing check is tether's own, in
# server/src/machine/tailscale.ts, and it is the one with the tests.
#
# A field that is present but `null` is an absence, and is dropped below so it
# answers `unknown` like a missing one — which is what tailscale.ts's `record()`
# and `Array.isArray` already do with it. tailscale has not been observed
# emitting null for either field; the parity is kept because the direction this
# fails in matters, not because the shape was seen.
ts_funnel_permission() {
	local json
	json=$(printf '%s' "$1" | tr -d '[:space:]')
	json=${json//\"CapMap\":null/}
	json=${json//\"Capabilities\":null/}
	case "$json" in
	*'"CapMap"'* | *'"Capabilities"'*) ;;
	*)
		printf 'unknown\n'
		return
		;;
	esac
	case "$json" in
	*'"funnel"'*) printf 'yes\n' ;;
	*) printf 'no\n' ;;
	esac
}

# This machine's MagicDNS name — the public address Funnel serves it under, and
# the Host the probe below asks tether to accept. `Self.DNSName`, minus its
# trailing dot, which is the field and the treatment
# server/src/machine/tailscale.ts uses. Deliberately not scraped out of
# `tailscale funnel status`, whose `https://<name> (Funnel on)` line is prose
# another tool owns and is free to reword. Empty means this tailnet gave the
# machine no name, which is MagicDNS being off — and it can only mean that,
# because ts_readable has already separated out the document that says nothing.
ts_dns_name() {
	printf '%s' "$1" |
		sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
		head -n 1 | sed 's/\.$//'
}

# Whether Funnel is already published at tether's port — `$1` is
# `tailscale serve status --json`, `$2` the host. A different question from
# ts_funnel_permission above, and the two must not be run together: a tailnet
# may permit Funnel with nothing armed, which is the state **every** fresh
# machine is in and the one that has to go on and arm it. This one is what makes
# a re-run skip the sudo rather than repeat it.
#
# Structured for the same reason as everything above, and here the reason is
# sharper than tidiness: `tailscale funnel status` *is* `tailscale serve status`,
# so a tailnet-only `tailscale serve --bg 8787` prints the identical
# `proxy http://127.0.0.1:8787` line under a `(tailnet only)` heading. Reading
# that line would call Funnel armed when it is not, skip the arm, and end the run
# telling someone to open a link that answers nothing — and the Host probe cannot
# catch it, since it only proves tether accepts the name, never that Funnel is in
# front of it.
#
# So both halves are asked, because they are different questions:
# `AllowFunnel["<name>:443"]` is `true` when Funnel is on for this host, and
# `Web["<name>:443"].Handlers["/"].Proxy` is what it points at. Note the two
# ports: the key carries Funnel's own 443, the proxy value carries tether's.
# Shape read off tailscale 1.98.10. Whitespace is stripped so the match does not
# depend on how the JSON is laid out.
#
# **Absent means "not armed", and that is the one direction this may fail in.**
# A machine with nothing served prints `{}`, and so does one whose serve
# configuration this cannot read; both cost a re-run of a command the user has
# already seen and agreed to, whereas guessing "armed" ends the run handing over
# a link to nothing. `AllowFunnel` may therefore never be read as an answer to
# whether the *tailnet* permits Funnel: it is absent on every machine that has
# not armed it yet, which is not a policy at all.
funnel_armed() {
	local json
	json=$(printf '%s' "$1" | tr -d '[:space:]')
	case "$json" in
	*"\"AllowFunnel\":{"*"\"$2:443\":true"*) ;;
	*) return 1 ;;
	esac
	case "$json" in
	*"\"Proxy\":\"http://127.0.0.1:$PORT\""*) return 0 ;;
	*) return 1 ;;
	esac
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

# A Funnel mapping survives reboot; a process launched with nohup does not. Use
# the user's native service manager when one is actually reachable from this
# login, and otherwise keep the old background fallback rather than pretending
# a file was enabled when its manager never saw it.
service_kind() {
	if [ "$OS" = macos ] && command -v launchctl >/dev/null 2>&1 &&
		launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
		printf 'launchd\n'
	elif [ "$OS" = linux ] && command -v systemctl >/dev/null 2>&1 &&
		systemctl --user show-environment >/dev/null 2>&1; then
		printf 'systemd\n'
	else
		printf 'none\n'
	fi
}

xml_escape() {
	printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}

systemd_escape() {
	local value=$1
	value=${value//\\/\\\\}
	value=${value//\"/\\\"}
	value=${value//%/%%}
	printf '%s' "$value"
}

linux_package_manager() {
	local manager
	for manager in apt-get dnf yum zypper pacman apk; do
		if command -v "$manager" >/dev/null 2>&1; then
			printf '%s\n' "$manager"
			return 0
		fi
	done
	return 1
}

# Fill the three package arrays from strings alone. Keeping this separate from
# detection lets --self-test cover every supported distribution on one CI host.
configure_linux_packages() {
	local manager=$1 needs_compiler=$2 tmux=$3 package seen existing
	local -a unique_packages=()
	system_packages=()
	package_update=()
	package_install=()
	case "$manager" in
	apt-get)
		package_manager=apt
		if ((needs_compiler)); then system_packages+=(build-essential python3); fi
		if [ "$tmux" != ok ]; then
			((needs_compiler)) || system_packages+=(build-essential)
			system_packages+=(bison libevent-dev libncurses-dev pkg-config)
		fi
		package_update=(apt-get update)
		package_install=(apt-get install -y)
		;;
	dnf)
		package_manager=dnf
		if ((needs_compiler)); then system_packages+=(gcc gcc-c++ make python3); fi
		if [ "$tmux" != ok ]; then
			system_packages+=(gcc gcc-c++ make bison libevent-devel ncurses-devel pkgconf-pkg-config)
		fi
		package_install=(dnf install -y)
		;;
	yum)
		package_manager=yum
		if ((needs_compiler)); then system_packages+=(gcc gcc-c++ make python3); fi
		if [ "$tmux" != ok ]; then
			system_packages+=(gcc gcc-c++ make bison libevent-devel ncurses-devel pkgconfig)
		fi
		package_install=(yum install -y)
		;;
	zypper)
		package_manager=zypper
		if ((needs_compiler)); then system_packages+=(gcc gcc-c++ make python3); fi
		if [ "$tmux" != ok ]; then
			system_packages+=(gcc gcc-c++ make bison libevent-devel ncurses-devel pkg-config)
		fi
		package_install=(zypper --non-interactive install)
		;;
	pacman)
		package_manager=pacman
		system_packages+=(base-devel python libevent ncurses)
		package_install=(pacman -S --needed --noconfirm)
		;;
	apk)
		package_manager=apk
		system_packages+=(build-base python3)
		if [ "$tmux" != ok ]; then
			system_packages+=(bison libevent-dev ncurses-dev pkgconf)
		fi
		package_install=(apk add)
		;;
	*) return 1 ;;
	esac
	for package in "${system_packages[@]}"; do
		existing=0
		for seen in "${unique_packages[@]}"; do
			if [ "$seen" = "$package" ]; then existing=1; break; fi
		done
		((existing)) || unique_packages+=("$package")
	done
	system_packages=("${unique_packages[@]}")
}

package_plan_shape() {
	configure_linux_packages "$@" || return 1
	printf '%s|%s|%s\n' "${package_update[*]}" "${package_install[*]}" "${system_packages[*]}"
}

service_file() {
	case "$1" in
	launchd) printf '%s/Library/LaunchAgents/%s.plist\n' "$HOME" "$SERVICE_LABEL" ;;
	systemd) printf '%s/systemd/user/tether.service\n' "${XDG_CONFIG_HOME:-$HOME/.config}" ;;
	esac
}

# Render first, then show exactly those bytes before asking to write them. PATH
# is captured because neither launchd nor a systemd user manager reads a shell
# startup file; without it a service that starts tether can still fail to find
# `claude`, `codex`, tmux or a version-manager's node.
render_service() {
	local kind=$1 output=$2 log state path home bin
	log=$(serve_log)
	state=$(dirname "$log")
	if [ "$kind" = launchd ]; then
		path=$(xml_escape "$PATH")
		home=$(xml_escape "$HOME")
		bin=$(xml_escape "$BIN_DIR/tether")
		log=$(xml_escape "$log")
		state=$(xml_escape "$state")
		cat >"$output" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bin</string><string>serve</string><string>--funnel</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$home</string>
    <key>PATH</key><string>$path</string>
    <key>TETHER_STATE_DIR</key><string>$state</string>
  </dict>
  <key>WorkingDirectory</key><string>$home</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
	else
		path=$(systemd_escape "$PATH")
		home=$(systemd_escape "$HOME")
		bin=$(systemd_escape "$BIN_DIR/tether")
		state=$(systemd_escape "$state")
		log=$(systemd_escape "$log")
		cat >"$output" <<EOF
[Unit]
Description=tether remote coding-agent control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="HOME=$home"
Environment="PATH=$path"
Environment="TETHER_STATE_DIR=$state"
WorkingDirectory="$home"
ExecStart="$bin" serve --funnel --port $PORT
Restart=on-failure
RestartSec=5
StandardOutput="append:$log"
StandardError="append:$log"

[Install]
WantedBy=default.target
EOF
	fi
}

service_loaded() {
	case "$1" in
	launchd) launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 ;;
	systemd) systemctl --user is-active --quiet tether.service ;;
	*) return 1 ;;
	esac
}

# Installs and starts the native service. `$2` says an unmanaged server already
# answers correctly; in that migration case the service is enabled for the next
# login/reboot but does not fight the live process for its port.
install_server_service() {
	local kind=$1 already=$2 file tmp loaded=0 linger=0 unchanged=0 file_q dir_q root_prefix user_name
	user_name=${USER:-$(id -un)}
	[ "$kind" != none ] || return 1
	file=$(service_file "$kind")
	tmp=$(mktemp)
	render_service "$kind" "$tmp"
	service_loaded "$kind" && loaded=1

	if [ "$kind" = systemd ] && command -v loginctl >/dev/null 2>&1 &&
		[ "$(loginctl show-user "$user_name" -p Linger --value 2>/dev/null || true)" != yes ]; then
		linger=1
	fi
	if [ -f "$file" ] && cmp -s "$tmp" "$file"; then unchanged=1; fi

	# A byte-identical service file is the durable record of the earlier consent.
	# Re-running an upgrade should not ask the same question again. It may restart
	# that already-installed service, but it introduces no new file or privilege.
	if ((unchanged)) && ((linger == 0)); then
		rm -f "$tmp"
		if ((loaded)); then
			note "The tether user service is already installed and running."
			return 0
		fi
		if ((already)); then
			note "The tether user service is already installed; it takes over next login/boot."
			return 0
		fi
		if [ "$kind" = launchd ]; then
			launchctl bootstrap "gui/$(id -u)" "$file" || return 1
		else
			systemctl --user daemon-reload || return 1
			systemctl --user enable --now tether.service || return 1
		fi
		note "Started the existing tether user service."
		return 0
	fi

	step "Keep tether running after this terminal closes"
	file_q=$(printf '%q' "$file")
	dir_q=$(printf '%q' "$(dirname "$file")")
	if [ "$(id -u)" -eq 0 ]; then root_prefix=""; else root_prefix="sudo "; fi
	note "This writes one user service file outside tether's directory with:"
	note "  mkdir -p $dir_q"
	note "  cat > $file_q <<'TETHER_SERVICE'"
	cat "$tmp"
	printf 'TETHER_SERVICE\n'
	note "  chmod 600 $file_q"
	if [ "$kind" = launchd ]; then
		if ((loaded)); then
			note "Then it reloads the existing service:"
			note "  launchctl bootout gui/$(id -u)/$SERVICE_LABEL"
			note "  launchctl bootstrap gui/$(id -u) $file"
		elif ((already)); then
			note "The healthy unmanaged server stays up; launchd reads this file next login."
		else
			note "Then it runs:"
			note "  launchctl bootstrap gui/$(id -u) $file"
		fi
	else
		note "Then it runs:"
		note "  systemctl --user daemon-reload"
		if ((linger)); then
			note "  ${root_prefix}loginctl enable-linger $user_name"
			note "That command lets this user service start at boot before an SSH login."
		fi
		if ((already)) && ((loaded == 0)); then
			note "  systemctl --user enable tether.service"
		else
			note "  systemctl --user enable --now tether.service"
			note "  systemctl --user restart tether.service"
		fi
	fi
	if ! confirm "Install and enable this service?"; then
		rm -f "$tmp"
		return 1
	fi

	mkdir -p "$(dirname "$file")"
	install -m 600 "$tmp" "$file"
	rm -f "$tmp"
	if [ "$kind" = launchd ]; then
		if ((loaded)); then
			launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" || true
			launchctl bootstrap "gui/$(id -u)" "$file" || return 1
		elif ((already)); then
			note "The current server is left running. launchd will take over at the next login."
		else
			launchctl bootstrap "gui/$(id -u)" "$file" || return 1
		fi
	else
		systemctl --user daemon-reload || return 1
		if ((linger)); then as_root loginctl enable-linger "$user_name" || return 1; fi
		if ((already)) && ((loaded == 0)); then
			systemctl --user enable tether.service || return 1
			note "The current server is left running. systemd will take over at the next boot."
		else
			systemctl --user enable --now tether.service || return 1
			systemctl --user restart tether.service || return 1
		fi
	fi
	note "Installed $file"
	return 0
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
	check_out 'apt-get update|apt-get install -y|build-essential python3 bison libevent-dev libncurses-dev pkg-config' package_plan_shape apt-get 1 old
	check_out '|dnf install -y|gcc gcc-c++ make bison libevent-devel ncurses-devel pkgconf-pkg-config' package_plan_shape dnf 0 old
	check_out '|yum install -y|gcc gcc-c++ make python3' package_plan_shape yum 1 ok
	check_out '|zypper --non-interactive install|gcc gcc-c++ make bison libevent-devel ncurses-devel pkg-config' package_plan_shape zypper 0 old
	check_out '|pacman -S --needed --noconfirm|base-devel python libevent ncurses' package_plan_shape pacman 1 old
	check_out '|apk add|build-base python3 bison libevent-dev ncurses-dev pkgconf' package_plan_shape apk 1 old
	check 1 configure_linux_packages unknown 1 old

	check_out first path_message_state "$bin" "$bin/tether" "$bin:/usr/bin"
	check_out later path_message_state "$bin" /home/u/.nvm/bin/tether "/home/u/.nvm/bin:$bin:/usr/bin"
	check_out absent path_message_state "$bin" /home/u/.nvm/bin/tether /home/u/.nvm/bin:/usr/bin
	check_out absent path_message_state "$bin" '' /usr/bin
	check_out absent path_message_state "$bin" /usr/bin/tether /home/u/.local/binx:/usr/bin
	check_out later path_message_state "$bin" /usr/bin/tether "/usr/bin:$bin"
	check_out later path_message_state "$bin" /usr/bin/tether "$bin"

	# Service files are security-relevant setup outside tether's own directory.
	# Prove both formats escape paths instead of turning one into plist XML or
	# systemd syntax, and that each carries the browser-only Funnel mode.
	local service_tmp saved_home saved_path saved_bin saved_state had_state=0
	service_tmp=$(mktemp -d)
	saved_home=$HOME
	saved_path=$PATH
	saved_bin=$BIN_DIR
	if [ -n "${TETHER_STATE_DIR+x}" ]; then had_state=1; saved_state=$TETHER_STATE_DIR; fi
	export HOME='/home/test & user' PATH='/usr/bin:/bin:/opt/node:%bin' TETHER_STATE_DIR='/state/test'
	BIN_DIR="$HOME/.local/bin"
	render_service launchd "$service_tmp/tether.plist"
	render_service systemd "$service_tmp/tether.service"
	HOME=$saved_home
	PATH=$saved_path
	BIN_DIR=$saved_bin
	if ((had_state)); then TETHER_STATE_DIR=$saved_state; else unset TETHER_STATE_DIR; fi
	check 0 grep -Fq '<string>/home/test &amp; user/.local/bin/tether</string>' "$service_tmp/tether.plist"
	check 0 grep -Fq '<string>--funnel</string>' "$service_tmp/tether.plist"
	check 0 grep -Fq 'ExecStart="/home/test & user/.local/bin/tether" serve --funnel --port 8787' "$service_tmp/tether.service"
	check 0 grep -Fq 'Environment="PATH=/usr/bin:/bin:/opt/node:%%bin"' "$service_tmp/tether.service"
	check 0 grep -Fq 'Environment="TETHER_STATE_DIR=/state/test"' "$service_tmp/tether.service"
	if command -v plutil >/dev/null 2>&1; then
		check 0 plutil -lint "$service_tmp/tether.plist"
	fi
	if command -v systemd-analyze >/dev/null 2>&1; then
		cp "$service_tmp/tether.service" "$service_tmp/verified.service"
		sed -i \
			-e 's#^WorkingDirectory=.*#WorkingDirectory=/#' \
			-e 's#^ExecStart=.*#ExecStart=/bin/true#' \
			"$service_tmp/verified.service"
		check 0 systemd-analyze verify "$service_tmp/verified.service"
	fi
	rm -rf "$service_tmp"

	# The two Funnel questions, and the fresh machine is the case that gets both
	# wrong when they are conflated: it is `yes` to permitted and `no` to armed,
	# and neither answer may be inferred from the other's field. Documents are
	# the shapes tailscale 1.98.10 really prints,
	# trimmed to the tokens these read — the full capture of the first is
	# server/src/machine/fixtures/tailscale-status.json, which tailscale.test.ts
	# drives; the negative and capability-less ones cannot be captured without an
	# account-level change and are built here instead, exactly as that fixture's
	# README does for the same reason.
	local permitted unpermitted no_caps
	permitted='{"BackendState":"Running","Self":{"DNSName":"my-box.tailnet-1234.ts.net.","CapMap":{"funnel":null,"https":null}}}'
	unpermitted='{"BackendState":"Running","Self":{"DNSName":"my-box.tailnet-1234.ts.net.","CapMap":{"https":null}}}'
	no_caps='{"BackendState":"Running","Self":{"DNSName":"my-box.tailnet-1234.ts.net."}}'
	check_out yes ts_funnel_permission "$permitted"
	check_out yes ts_funnel_permission '{"BackendState":"Running","Self":{"Capabilities":["funnel","https"]}}'
	check_out no ts_funnel_permission "$unpermitted"
	# The regression this file exists for: a Running node reporting no capability
	# set is "tether cannot tell", never "your tailnet forbids it".
	check_out unknown ts_funnel_permission "$no_caps"
	check_out unknown ts_funnel_permission ''
	# A present-but-null capability field is an absence too, and answers the same
	# as a missing one — parity with tailscale.ts, which reads null as no set.
	check_out unknown ts_funnel_permission '{"BackendState":"Running","Self":{"CapMap":null}}'
	check_out unknown ts_funnel_permission '{"BackendState":"Running","Self":{"CapMap": null, "Capabilities": null}}'
	# Null beside a real set is not an absence: the set still answers.
	check_out yes ts_funnel_permission '{"BackendState":"Running","Self":{"CapMap":null,"Capabilities":["funnel"]}}'
	check 0 ts_readable "$permitted"
	check 1 ts_readable ''
	check 1 ts_readable '{}'
	check_out Running ts_state "$permitted"
	check_out my-box.tailnet-1234.ts.net ts_dns_name "$permitted"
	# MagicDNS off. Distinguishable from an unreadable document only because
	# ts_readable answers that one first.
	check_out '' ts_dns_name '{"BackendState":"Running","Self":{"CapMap":{"funnel":null}}}'

	# Armed is a different question, and `{}` — a machine with nothing served,
	# which is every fresh one — is a "no" that must go on and arm rather than
	# being read as a tailnet that forbids Funnel.
	local armed
	armed='{"TCP":{"443":{"HTTPS":true}},"Web":{"my-box.tailnet-1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}},"AllowFunnel":{"my-box.tailnet-1234.ts.net:443":true}}'
	check 0 funnel_armed "$armed" my-box.tailnet-1234.ts.net
	check 1 funnel_armed '{}' my-box.tailnet-1234.ts.net
	check 1 funnel_armed '' my-box.tailnet-1234.ts.net
	# Served on the tailnet only: the same proxy line, no AllowFunnel.
	check 1 funnel_armed \
		'{"Web":{"my-box.tailnet-1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}' \
		my-box.tailnet-1234.ts.net
	# Funnel on for a different host on this tailnet.
	check 1 funnel_armed "$armed" other-box.tailnet-1234.ts.net

	# Moving an existing install to another ref, which the shallow clone makes the
	# non-obvious half of this script: a fresh clone can be told to fetch any ref,
	# an existing one holds exactly the one it was cloned at. Both cases that
	# matter are here — a newer tag, which is an upgrade, and a branch, which is
	# how an unreleased change gets tested — against a local repository rather
	# than the network, so what is under test is the refspec logic and nothing
	# else. git is a hard requirement of this script, so this needs nothing CI
	# does not already have.
	#
	# `quiet` because git's own progress output is not what is under test. It is
	# invoked through `check` rather than directly, which shellcheck cannot see.
	# Both codes, because which one it reports depends on the shellcheck version:
	# SC2329 since 0.10, SC2317 before it.
	# shellcheck disable=SC2317,SC2329
	quiet() { "$@" >/dev/null 2>&1; }
	local tmp
	tmp=$(mktemp -d)
	if (
		set -e
		export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
		git init -q -b main "$tmp/origin"
		cd "$tmp/origin"
		echo v1 >VERSION && git add -A && git commit -qm one && git tag v0.1.0
		echo v2 >VERSION && git commit -qam two && git tag v0.2.0
		echo tip >VERSION && git commit -qam three
		git clone -q --branch v0.1.0 --depth 1 "file://$tmp/origin" "$tmp/clone"
	) >/dev/null 2>&1; then
		# An upgrade to a newer tag, which is the ordinary re-run.
		check 0 quiet update_checkout "$tmp/clone" v0.2.0
		check_out v2 cat "$tmp/clone/VERSION"
		# The tag ref came with it, so the install directory can still say what it
		# is — `git describe` there is how that question gets answered.
		check_out v0.2.0 git -C "$tmp/clone" describe --tags
		# A branch: no refs/tags/main to fetch, and the failure this all exists for
		# was `git checkout main` on a checkout holding one tag.
		check 0 quiet update_checkout "$tmp/clone" main
		check_out tip cat "$tmp/clone/VERSION"
		# A ref the remote does not have fails rather than silently building what
		# is already there — main() is what turns that into a message.
		check 1 quiet update_checkout "$tmp/clone" v9.9.9
		check_out tip cat "$tmp/clone/VERSION"
		# None of which may cost the shallow clone's speed.
		check_out true git -C "$tmp/clone" rev-parse --is-shallow-repository
	else
		printf 'FAIL: could not build the self-test repository in %s\n' "$tmp"
		fails=1
	fi
	rm -rf "$tmp"

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
	local status state url host log ts_installer kind already service_installed

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

	# 1 ── installed? Only the host needs Tailscale. A person opening the
	# finished HTTPS link uses an ordinary browser and no Tailscale account.
	if ! command -v tailscale >/dev/null 2>&1; then
		step "Tailscale is not installed"
		if [ "$OS" = macos ]; then
			# Tailscale's current macOS guidance recommends the signed Standalone
			# system-extension package over both the App Store sandbox and the
			# command-line-only build. macOS's installer verifies its signature.
			ts_installer=$(mktemp -d)
			note "Tailscale recommends its signed Standalone macOS package. These are"
			note "the exact commands this script offers to run:"
			note ""
			note "  curl -sSfL --proto '=https' -o $ts_installer/Tailscale.pkg $TAILSCALE_MACOS_PKG"
			note "  sudo /usr/sbin/installer -pkg $ts_installer/Tailscale.pkg -target /"
			note "  open -a Tailscale"
			note ""
			note "Tailscale is installed only on this Mac. People opening tether's link"
			note "need a browser and the tether password — no Tailscale app or account."
			if ! confirm "Install it?"; then
				rm -rf "$ts_installer"
				step "Tailscale was not installed."
				note "Download the Standalone package yourself from:"
				note "  https://tailscale.com/download/mac"
				return 1
			fi
			step "Installing Tailscale"
			curl -sSfL --proto '=https' -o "$ts_installer/Tailscale.pkg" \
				"$TAILSCALE_MACOS_PKG" || {
				rm -rf "$ts_installer"
				die "could not download $TAILSCALE_MACOS_PKG"
			}
			as_root /usr/sbin/installer -pkg "$ts_installer/Tailscale.pkg" -target / || {
				rm -rf "$ts_installer"
				note "macOS's package installer refused Tailscale. Install the Standalone"
				note "package from https://tailscale.com/download/mac and re-run this script."
				return 1
			}
			rm -rf "$ts_installer"
			open -a Tailscale || true
		else
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
		fi
		hash -r
		command -v tailscale >/dev/null 2>&1 || {
			note "Tailscale's installer finished, but \`tailscale\` is not on PATH."
			note "Open the app once if this is macOS, then re-run this script."
			return 1
		}
	fi
	note "$(tailscale version 2>/dev/null | head -n 1)"

	# 2 ── logged in? Nothing below can be known until it is: a logged-out node
	# reports no capabilities at all, so asking about Funnel first would tell
	# someone to edit their access controls when they need to sign in. The same
	# goes for a tailscaled that answers nothing at all, which is what an
	# unreadable document is and why it shares this branch rather than falling
	# through it as an empty string.
	status=$(ts_status || true)
	state=""
	if ts_readable "$status"; then state=$(ts_state "$status"); fi
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
		# Re-read: signing in is what fills in everything below, so the document
		# from before it is stale for every question after this one.
		status=$(ts_status || true)
		state=""
		if ts_readable "$status"; then state=$(ts_state "$status"); fi
		[ "$state" = Running ] || {
			note "Tailscale reports state \"${state:-no answer from tailscaled}\". Re-run this script once it is Running."
			return 1
		}
	fi

	# 3 ── arm the public mapping. Current Tailscale owns the one-time enable
	# flow: `tailscale funnel` can open the account approval that enables HTTPS
	# certificates and adds the Funnel policy. Pre-emptively refusing on a missing
	# capability strands a fresh user before the command that fixes it, so the
	# capability read is advisory and the command's own refusal is authoritative.
	host=$(ts_dns_name "$status")
	if [ -n "$host" ] && funnel_armed "$(tailscale serve status --json 2>/dev/null || true)" "$host"; then
		note "Funnel already points at 127.0.0.1:$PORT."
	else
		step "This publishes this machine on the internet"
		note "- sudo tailscale funnel --yes --bg $PORT"
		note ""
		note "On a fresh tailnet, Tailscale may open its own account approval to enable"
		note "HTTPS and Funnel. That is the setup flow, not a separate error to repair."
		note "Only this host runs Tailscale; anyone opening the finished link needs"
		note "only a browser and the tether password."
		note ""
		note "It stays on across reboots until you turn it off:"
		note ""
		note "  sudo tailscale funnel --bg off"
		case "$(ts_funnel_permission "$status")" in
		no)
			note ""
			note "This node does not currently report the Funnel capability. The command"
			note "above is the supported way to request it; a non-admin is refused in"
			note "Tailscale's own words rather than being sent to guess at a policy file."
			;;
		unknown)
			note ""
			note "Tailscale reports no capability set for this machine. Carrying on:"
			note "silence is not evidence that the tailnet denied Funnel."
			;;
		esac
		if ! confirm "Publish it?"; then
			step "Funnel was not turned on."
			note "tether is installed and works on loopback. Turn Funnel on whenever"
			note "you want to, with the command above."
			return 1
		fi
		step "Turning Funnel on"
		# The exact machine-wide command is on screen and has been consented to.
		# `--yes` answers Tailscale's local CLI confirmation; any account-level
		# approval it needs remains Tailscale's own browser flow.
		as_root tailscale funnel --yes --bg "$PORT" || {
			note "\`tailscale funnel\` failed. tether is installed and works on loopback."
			return 1
		}

		# Enabling Funnel is what can create the hostname and capabilities, so no
		# pre-enable status document may be reused after it.
		status=$(ts_status || true)
		state=""
		if ts_readable "$status"; then state=$(ts_state "$status"); fi
		[ "$state" = Running ] || {
			note "Tailscale stopped answering after Funnel setup (state: ${state:-unknown})."
			return 1
		}
		host=$(ts_dns_name "$status")
	fi

	[ -n "$host" ] || {
		step "Tailscale reports no public name for this machine"
		note "The Funnel command completed but no MagicDNS name appeared. Open"
		note "https://login.tailscale.com/admin/dns, then re-run this installer."
		return 1
	}
	funnel_armed "$(tailscale serve status --json 2>/dev/null || true)" "$host" || {
		step "Tailscale did not leave Funnel armed for tether"
		note "Run this once, complete any approval it opens, and re-run the installer:"
		note ""
		note "  sudo tailscale funnel --yes --bg $PORT"
		return 1
	}
	url="https://$host"

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
	# 0700 to match the directory tether itself creates for its state; -m applies
	# only where this is the thing creating it.
	# shellcheck disable=SC2174
	mkdir -p -m 700 "$(dirname "$log")"
	already=0
	if serving_as "$host"; then
		already=1
		note "tether is already serving on 127.0.0.1:$PORT for $host."
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
	fi

	kind=$(service_kind)
	service_installed=0
	if install_server_service "$kind" "$already"; then
		service_installed=1
	elif ! serving_as "$host"; then
		step "Starting tether for this login"
		if [ "$kind" = none ]; then
			note "No launchd or systemd user manager is reachable here, so automatic"
			note "restart after reboot is unavailable on this host."
		else
			note "The persistent service was declined or could not start."
		fi
		# The supported fallback changes no startup file and no system service.
		nohup "$BIN_DIR/tether" serve --funnel --port "$PORT" >>"$log" 2>&1 </dev/null &
		note "Running in the background for this login; output goes to $log"
	fi

	for _ in 1 2 3 4 5 6 7 8 9 10; do
		serving_as "$host" && break
		sleep 1
	done
	serving_as "$host" || {
		note "tether did not come up for $host. What it printed is in $log."
		return 1
	}
	if ((service_installed)); then
		note "The persistent user service is installed; output goes to $log"
	fi

	step "Checking the real public HTTPS link"
	if curl -fsS -o /dev/null --max-time 15 "$url/" 2>/dev/null; then
		note "$url answered through Funnel."
	else
		note "The loopback service and Funnel mapping are ready, but public DNS has"
		note "not answered yet. Tailscale says a new Funnel name can take up to ten"
		note "minutes to propagate. Check without changing it with commands available"
		note "in every released install this script may have selected:"
		note ""
		note "  tailscale funnel status"
		note "  curl -I $url/"
	fi

	step "Open this in any browser"
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
		--access)
			ACCESS="${2:-}"
			case "$ACCESS" in public | local) ;; *) die '--access needs public or local' ;; esac
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
		# Re-running the installer is how tether is upgraded, and setting
		# TETHER_VERSION on an existing install is how it moves to any other ref.
		step "Updating $TARGET_DIR to $VERSION"
		if ! update_checkout "$TARGET_DIR" "$VERSION"; then
			# Which ref it is left at, rather than "as it is": the whole failure here
			# is ending up on a version other than the one that was asked for, and a
			# message that does not say which one leaves that invisible.
			note "could not check out $VERSION — leaving $TARGET_DIR at $(git -C "$TARGET_DIR" describe --tags --always 2>/dev/null || echo 'its current ref') and building that."
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

	system_packages=()
	package_update=()
	package_install=()
	package_manager=""
	brew_cmd=()
	plan=()
	if [ "$(id -u)" -eq 0 ]; then root_prefix=""; else root_prefix="sudo "; fi
	if [ "$OS" = linux ] && { ((need_toolchain)) || [ "$tmux_state" != ok ]; }; then
		# Tailscale's own installer supports this distribution range; tether's
		# build used to stop everywhere except apt. Package names are explicit per
		# manager so the consent plan is a command that can actually run here.
		manager=$(linux_package_manager || true)
		if [ -z "$manager" ] || ! configure_linux_packages "$manager" "$need_toolchain" "$tmux_state"; then
			step "This Linux distribution needs build prerequisites"
			note "No supported package manager was found (apt, dnf, yum, zypper,"
			note "pacman or apk). Put cc, c++, make and python3 on PATH; if tmux is"
			note "older than $TMUX_MIN_MAJOR.$TMUX_MIN_MINOR, also install bison, libevent and ncurses headers."
			note "Then re-run this installer. The tmux source recipe is:"
			note ""
			tmux_build_recipe
			die "could not install this distribution's build prerequisites."
		fi
		plan+=("${root_prefix}${package_install[*]} ${system_packages[*]}")
		if [ "$tmux_state" != ok ]; then
			plan+=("build tmux $TMUX_VERSION from source and install it to /usr/local/bin")
		fi
	elif [ "$OS" = macos ] && [ "$tmux_state" != ok ]; then
		command -v brew >/dev/null 2>&1 ||
			die "tmux $TMUX_MIN_MAJOR.$TMUX_MIN_MINOR or newer is required and Homebrew is not installed. Install Homebrew from https://brew.sh and re-run, or build tmux $TMUX_VERSION yourself."
		# `brew upgrade` refuses a formula Homebrew does not have installed, and the
		# too-old tmux on PATH is as likely to be MacPorts', Nix's or a hand-built one.
		if brew list --formula tmux >/dev/null 2>&1; then
			brew_cmd=(brew upgrade tmux)
		else
			brew_cmd=(brew install tmux)
		fi
		plan+=("${brew_cmd[*]}")
	fi

	if ((${#plan[@]})); then
		step "This needs to change something outside tether's own directory"
		if ((${#package_update[@]})); then note "- ${root_prefix}${package_update[*]}"; fi
		for line in "${plan[@]}"; do note "- $line"; done
		if [ "$OS" = linux ] && [ "$tmux_state" != ok ]; then
			note ""
			note "The exact source build after those packages is:"
			tmux_build_recipe
		fi
		# "Installs to /usr/local/bin" is only "leaves yours alone" when yours is
		# somewhere else. If it is not, this overwrites a working tmux, and that is
		# the user's call to make rather than a detail to leave off the plan.
		if [ "$OS" = linux ] && [ "$tmux_state" = old ]; then
			note ""
			case "$(command -v tmux)" in
			/usr/local/bin/*) note "This REPLACES the tmux already at $(command -v tmux)." ;;
			*)
				note "Your existing tmux at $(command -v tmux) is left exactly where it is."
				note "tmux $TMUX_VERSION goes to /usr/local/bin. Which of the two your PATH"
				note "then runs is checked after the build, and named here if it is the old one."
				;;
			esac
		fi
		if ! confirm "Proceed?"; then
			step "Nothing was installed."
			note "Run the exact commands above yourself and re-run this script, or use --yes."
			if [ "$OS" = linux ] && [ "$tmux_state" != ok ]; then tmux_build_recipe; fi
			exit 1
		fi
	fi

	if ((${#system_packages[@]})); then
		step "Installing system packages with $package_manager"
		if ((${#package_update[@]})); then as_root "${package_update[@]}" </dev/null; fi
		as_root "${package_install[@]}" "${system_packages[@]}" </dev/null
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

	# node-pty's macOS prebuild ships `spawn-helper` without its executable bit,
	# and macOS starts every process through that helper — so without this, every
	# terminal attach fails with `posix_spawnp failed`, which is the only symptom
	# there is. A chmod inside node_modules, so it is scoped to node-pty's own
	# directory and to files named exactly that. All of node-pty's native
	# directories rather than one: which of them is live (`build/Release` where it
	# compiled here, `prebuilds/<platform>-<arch>` where it did not) is node-pty's
	# decision, and an architecture guessed at here would be wrong on the next
	# machine.
	#
	# The repo does the same on every `npm ci`, in the root package.json's
	# `postinstall`. This is not that being duplicated for safety: this script is
	# fetched from `main` and installs a *tag*, so the checkout it has just built
	# can predate that postinstall entirely, and on a Mac that is the whole bug
	# again. Which is also why the check below is written out here rather than
	# calling the repo's own — a released tag has neither.
	find node_modules/node-pty -type f -name spawn-helper -exec chmod +x {} + 2>/dev/null || true

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

	# The one thing every check above leaves untested: whether a terminal can
	# start at all. Node and tmux are prerequisites; this is the product, and it
	# is the check whose absence cost three hours of blind debugging on a Mac —
	# the install said it was done, and the failure arrived later as a node-pty
	# stack trace in the server log. `node` itself rather than a command from
	# PATH: node-pty reports a refused `posix_spawnp` and a missing binary with
	# the same message, and this one provably exists. The timeout is because a
	# PTY that never exits would otherwise hang the install rather than fail it.
	#
	# It runs *after* the symlink and *before* the PATH block on purpose. On that
	# Mac the terminal was the only broken part — the session list, the badges and
	# the conversation view all worked — so dying before the link would take the
	# command away from a machine that is otherwise fine, while dying after the
	# PATH block would never run on a machine whose $BIN_DIR is not on PATH, which
	# exits 1 there. It still dies: a terminal that cannot start fails the install.
	step "Checking that a terminal can start"
	if ! node -e "const p = require('node-pty').spawn(process.execPath, ['-e', ''], { cols: 80, rows: 24 });
		setTimeout(() => { console.error('the process it started never exited'); process.exit(1); }, 20000);
		p.onExit(({ exitCode, signal }) => process.exit(exitCode || signal ? 1 : 0));"; then
		note "The error above is node-pty's, and node-pty is what tether starts every"
		note "terminal through. On macOS the usual cause is"
		note "node_modules/node-pty/prebuilds/<arch>/spawn-helper missing its executable"
		note "bit — which this script has already set, so a failure here is something"
		note "else."
		note ""
		note "The tether command is installed, at $BIN_DIR/tether, and the conversation"
		note "view works: what will not work on this machine is the terminal. Re-run"
		note "this installer to check it again."
		die "tether cannot open a terminal on this machine."
	fi

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

	# Everything above installed tether. Public access is explicit in the option
	# name and again at the consent prompt; local is a complete successful install
	# that never invokes Tailscale or creates a service.
	if [ "$ACCESS" = public ] && reachability; then
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

		Re-running this script with --access public picks the browser-only Funnel
		setup up from wherever it stopped. Only this host installs Tailscale; people
		opening the finished HTTPS link use an ordinary browser.
	EOF
}

main "$@"
