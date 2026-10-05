// Keep the image self-contained so packaged servers do not depend on checkout-relative assets.
export const DESKTOP_FILES = {
  Containerfile: `FROM docker.io/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    xvfb openbox xcompmgr dbus-x11 at-spi2-core libatk-adaptor libxi6 libxkbcommon0 \\
    libxtst6 mousepad fonts-dejavu-core x11-utils procps \\
    && rm -rf /var/lib/apt/lists/* \\
    && useradd --create-home --uid 1001 agent
COPY --chmod=755 cua-driver /usr/local/bin/cua-driver
COPY --chmod=755 entrypoint.sh desktop.sh mcp.sh wm-ready.sh /usr/local/bin/
ENV HOME=/tmp/agent XDG_RUNTIME_DIR=/tmp/agent/.runtime \\
    GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb NO_AT_BRIDGE=0 \\
    CUA_DRIVER_RS_ENABLE_WAYLAND=0 CUA_DRIVER_RS_TELEMETRY_ENABLED=false
USER 1001:1001
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["cua-driver", "mcp", "--direct"]
`,
  "entrypoint.sh": `#!/bin/bash
set -euo pipefail
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$HOME" "$XDG_RUNTIME_DIR"
exec dbus-run-session -- /usr/local/bin/desktop.sh "$@"
`,
  "desktop.sh": `#!/bin/bash
set -euo pipefail
unset WAYLAND_DISPLAY SESSION_MANAGER
trap 'status=$?; if (( status != 0 )); then tail -n 60 "$XDG_RUNTIME_DIR/xvfb.log" "$XDG_RUNTIME_DIR/openbox.log" >&2; fi' EXIT
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
mkfifo "$XDG_RUNTIME_DIR/display-ready" "$XDG_RUNTIME_DIR/wm-ready"
exec 3<>"$XDG_RUNTIME_DIR/display-ready"
Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp >"$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
read -r -t 20 display <&3
exec 3>&-
export DISPLAY=":$display"
exec 4<>"$XDG_RUNTIME_DIR/wm-ready"
openbox --startup /usr/local/bin/wm-ready.sh >"$XDG_RUNTIME_DIR/openbox.log" 2>&1 &
read -r -t 20 ready <&4
test "$ready" = ready
exec 4>&-
xcompmgr >"$XDG_RUNTIME_DIR/compositor.log" 2>&1 &
printf 'export DISPLAY=%q\\nexport DBUS_SESSION_BUS_ADDRESS=%q\\n' "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" >"$XDG_RUNTIME_DIR/desktop.env"
"$@" || true
exec sleep infinity
`,
  "wm-ready.sh": `#!/bin/bash
set -euo pipefail
printf 'ready\\n' >"$XDG_RUNTIME_DIR/wm-ready"
`,
  "mcp.sh": `#!/bin/bash
set -euo pipefail
source "$XDG_RUNTIME_DIR/desktop.env"
exec cua-driver mcp --direct
`,
} as const;
