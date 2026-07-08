#!/bin/sh
# Generate one Xvnc per display plus a single token-multiplexing websockify,
# then run supervisord. Display count is PYGAME_DISPLAYS (default 4); it must
# match the pygame manager's manager.displays.
#
# Per display i (1..N):
#   Xtightvnc :i on rfbport 5900+i
#   a token-file entry  display<i>: localhost:5900+i
# ONE websockify on :6080 routes each browser (which connects with
# ?token=display<i>) to that display's VNC. Using a single VNC port — rather
# than one per display — means the number of displays lives entirely in
# PYGAME_DISPLAYS: raising it needs no fly.toml service blocks and no exec
# nginx changes. The single shell server (:8010) renders each run on the
# display the manager passes in the eval payload (trinket/server.js).
set -e

N="${PYGAME_DISPLAYS:-4}"
echo "entrypoint: generating $N pygame display(s)"

mkdir -p /etc/websockify
: > /etc/websockify/tokens.conf

i=1
while [ "$i" -le "$N" ]; do
  rfb=$((5900 + i))

  cat > "/etc/supervisor/conf.d/xvnc-$i.conf" <<EOF
[program:xvnc$i]
command=/usr/bin/Xtightvnc :$i -rfbport $rfb -geometry 800x600 -depth 24 -ac
user=trinket
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/xvnc$i.log
stderr_logfile=/var/log/supervisor/xvnc$i.err.log
priority=100
EOF

  echo "display$i: localhost:$rfb" >> /etc/websockify/tokens.conf

  i=$((i + 1))
done

# Single token-multiplexing websockify on :6080. A browser connects to
# /pygame-vnc/websockify?token=display<n> (via exec nginx) and websockify
# proxies it to that display's VNC per the token file.
cat > /etc/supervisor/conf.d/novnc.conf <<EOF
[program:novnc]
command=/usr/bin/websockify --web=/usr/share/novnc/ --token-plugin TokenFile --token-source /etc/websockify/tokens.conf 6080
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/novnc.log
stderr_logfile=/var/log/supervisor/novnc.err.log
priority=200
EOF

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
