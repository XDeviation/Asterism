#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [ -e /etc/asterism/app.env ]; then
  echo "/etc/asterism/app.env already exists; refusing to rotate secrets." >&2
  exit 1
fi

umask 077
install -d -m 0700 /etc/asterism
openssl rand -base64 24 > /root/asterism-initial-password
openssl rand -hex 32 > /etc/asterism/session.secret
openssl rand -hex 32 > /etc/asterism/bot-service-token

cd /opt/asterism/current
node --input-type=module -e '
  import fs from "node:fs";
  import argon2 from "argon2";
  const password = fs.readFileSync("/root/asterism-initial-password", "utf8").trim();
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  fs.writeFileSync("/etc/asterism/site-password.hash", `${hash}\n`, { mode: 0o600 });
'

{
  printf '%s\n' \
    'HOST=127.0.0.1' \
    'PORT=3000' \
    'DATABASE_PATH=/var/lib/asterism-app/asterism.sqlite' \
    'PUBLIC_URL=https://hunt.lost-deviation.com' \
    'COOKIE_SECURE=true' \
    'TRUST_PROXY=1' \
    'WEB_DIST_DIR=/opt/asterism/current/apps/web/dist'
  printf 'SITE_PASSWORD_HASH='
  cat /etc/asterism/site-password.hash
  printf 'SESSION_SECRET='
  cat /etc/asterism/session.secret
  printf 'BOT_SERVICE_TOKEN='
  cat /etc/asterism/bot-service-token
} > /etc/asterism/app.env

chmod 0600 \
  /root/asterism-initial-password \
  /etc/asterism/app.env \
  /etc/asterism/site-password.hash \
  /etc/asterism/session.secret \
  /etc/asterism/bot-service-token
