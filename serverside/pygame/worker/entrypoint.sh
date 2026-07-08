#!/bin/sh
# Generate one Xvnc + one websockify supervisor program per display, then run
# supervisord. The number of displays is PYGAME_DISPLAYS (default 4); it must
# match the pygame manager's manager.displays so the manager never assigns a
# display the worker isn't running.
#
# Per display i (1..N):
#   Xtightvnc :i  on rfbport 5900+i
#   websockify   on 6080+i  ->  localhost:5900+i
# The single shell server (:8010) renders each run on the display the manager
# passes in the eval payload; see supervisor/shell.conf and trinket/server.js.
set -e

N="${PYGAME_DISPLAYS:-4}"
echo "entrypoint: generating $N pygame display(s)"

i=1
while [ "$i" -le "$N" ]; do
  rfb=$((5900 + i))
  ws=$((6080 + i))

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

  cat > "/etc/supervisor/conf.d/novnc-$i.conf" <<EOF
[program:novnc$i]
command=/usr/bin/websockify --web=/usr/share/novnc/ $ws localhost:$rfb
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/novnc$i.log
stderr_logfile=/var/log/supervisor/novnc$i.err.log
priority=200
EOF

  i=$((i + 1))
done

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
