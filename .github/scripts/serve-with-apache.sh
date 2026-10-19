#!/usr/bin/env bash
# Serve the built repo with Apache + mod_php at http://127.0.0.1/jquery/ for the
# QUnit browser suite (the ajax tests hit test/data/*.php).
#
# Run from the repo root after `npm test` has built dist/. Used by .travis.yml and
# the `test` job of .github/workflows/build.yml; needs sudo and apt.
#
# Why Apache prefork and many workers: test/data/core/dont_return.php sleeps 30s,
# and Chromium opens idle preconnect sockets that send no request. Either one
# blocks a worker, so the PHP built-in server stalled the suite.
set -euxo pipefail

DOCROOT=/var/www/html/jquery
BASE_URL=http://127.0.0.1/jquery

sudo apt-get install -y --no-install-recommends apache2 libapache2-mod-php rsync

# mod_php needs the prefork MPM. Enable exactly one PHP module (the newest installed).
phpmods="$(cd /etc/apache2/mods-available && ls php*.load | sed 's/\.load$//' | sort -V)"
phpmod="$(echo "$phpmods" | tail -n 1)"
for m in $phpmods; do
	if [ "$m" != "$phpmod" ]; then
		sudo a2dismod -q "$m"
	fi
done
sudo a2dismod -q mpm_event mpm_worker
sudo a2enmod -q mpm_prefork "$phpmod"

sudo tee /etc/apache2/conf-available/jquery-tests.conf > /dev/null <<'EOF'
# Plenty of prefork workers so no request waits behind dont_return.php
# (sleeps 30s) or behind Chromium's idle preconnect sockets.
<IfModule mpm_prefork_module>
	StartServers 20
	MinSpareServers 20
	MaxSpareServers 40
	MaxRequestWorkers 100
</IfModule>
EOF
sudo a2enconf -q jquery-tests

# /home is not world-traversable for www-data, so copy rather than symlink.
sudo rm -rf "$DOCROOT"
sudo mkdir -p "$DOCROOT"
sudo rsync -a --chmod=a+rX --exclude node_modules --exclude .git ./ "$DOCROOT/"

sudo apache2ctl configtest
sudo service apache2 restart
sudo apache2ctl -M 2>/dev/null | grep -Ei 'mpm|php'

for i in $(seq 1 30); do
	curl -sf -o /dev/null "$BASE_URL/test/index.html" && break
	sleep 1
done
curl -sf -o /dev/null "$BASE_URL/test/index.html"
curl -sf -o /dev/null "$BASE_URL/dist/jquery.js"

# PHP must be executed, not served as source.
out="$(curl -sf "$BASE_URL/test/data/name.php?name=foo")"
case "$out" in
	*"<?php"*) echo "Apache served raw PHP source; mod_php is not active" >&2; exit 1 ;;
esac
echo "Apache + $phpmod serving $DOCROOT at $BASE_URL"
