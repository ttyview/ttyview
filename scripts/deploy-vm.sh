#!/usr/bin/env bash
# deploy-vm.sh — provisions a single GCE VM hosting Tier 2 (spectator)
# and Tier 3 (sandbox broker) of the ttyview demo. Tier 1 lives on
# Cloud Run separately.
#
# Layout on the VM:
#   :8081  ttyview-daemon --read-only          (Tier 2 spectator)
#   :8082  ttyview-sandbox                     (Tier 3 broker)
#   :443   Caddy HTTPS reverse-proxy
#            /spectator  → 127.0.0.1:8081
#            /sandbox    → 127.0.0.1:8082
#            /           → redirect to /sandbox
#
# Requires: gcloud authed, project ttyview-demo selected.
set -euo pipefail

PROJECT=ttyview-demo
ZONE=us-central1-a
VM=ttyview-demo-vm
MACHINE=e2-micro      # free tier
IMAGE_FAMILY=debian-12
IMAGE_PROJECT=debian-cloud
GCLOUD=/snap/bin/gcloud

# For the first deploy we scp both binaries from the local target/release
# directory — the --demo / --read-only flags + the sandbox crate landed
# after v0.1.0 was tagged, so the GitHub release artifacts are stale.
# After v0.1.1+ we'll pull from the release like a normal install.
DAEMON_LOCAL=/home/eyalev/projects/personal/2026-05/ttyview/target/release/ttyview-daemon
SANDBOX_LOCAL=/home/eyalev/projects/personal/2026-05/ttyview/target/release/ttyview-sandbox

# 1. VM
if ! "$GCLOUD" compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "==> creating VM $VM ($MACHINE) in $ZONE"
  "$GCLOUD" compute instances create "$VM" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family "$IMAGE_FAMILY" \
    --image-project "$IMAGE_PROJECT" \
    --tags=http-server,https-server \
    --boot-disk-size=20GB
else
  echo "==> VM $VM already exists; skipping create"
fi

# 2. Firewall: HTTP + HTTPS
for FW in allow-http allow-https; do
  if ! "$GCLOUD" compute firewall-rules describe "$FW" --project "$PROJECT" >/dev/null 2>&1; then
    case "$FW" in
      allow-http)  PORT=80; TAG=http-server ;;
      allow-https) PORT=443; TAG=https-server ;;
    esac
    "$GCLOUD" compute firewall-rules create "$FW" \
      --project "$PROJECT" \
      --allow "tcp:${PORT}" \
      --target-tags="$TAG" \
      --source-ranges=0.0.0.0/0
  fi
done

EXTERNAL_IP=$("$GCLOUD" compute instances describe "$VM" --zone "$ZONE" --project "$PROJECT" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
echo "==> VM external IP: $EXTERNAL_IP"
HOSTNAME="${EXTERNAL_IP}.sslip.io"   # free wildcard DNS based on IP
echo "==> hostname: $HOSTNAME"

# 3. Wait for SSH
echo "==> waiting for SSH"
for i in {1..30}; do
  if "$GCLOUD" compute ssh "$VM" --zone "$ZONE" --project "$PROJECT" --command 'echo ok' 2>/dev/null | grep -q ok; then
    break
  fi
  sleep 5
done

# 4. Copy binaries up
echo "==> copying ttyview-daemon + ttyview-sandbox to VM"
"$GCLOUD" compute scp "$DAEMON_LOCAL" "$VM":/tmp/ttyview-daemon \
  --zone "$ZONE" --project "$PROJECT"
"$GCLOUD" compute scp "$SANDBOX_LOCAL" "$VM":/tmp/ttyview-sandbox \
  --zone "$ZONE" --project "$PROJECT"

# 5. Run remote bootstrap
echo "==> running remote bootstrap"
"$GCLOUD" compute ssh "$VM" --zone "$ZONE" --project "$PROJECT" --command "
set -euo pipefail
echo '== install packages =='
sudo apt-get update -qq
sudo apt-get install -y -qq tmux curl debian-keyring debian-archive-keyring apt-transport-https
# Caddy from official APT repo
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq caddy

echo '== install binaries =='
sudo install -m 0755 /tmp/ttyview-daemon /usr/local/bin/ttyview-daemon
sudo install -m 0755 /tmp/ttyview-sandbox /usr/local/bin/ttyview-sandbox

echo '== curated tmux session for Tier 2 (spectator) =='
# A persistent tmux server with one session running 'top' so visitors
# see live activity. systemd unit re-creates it on reboot.
sudo tee /etc/systemd/system/ttyview-spectator-tmux.service >/dev/null <<'UNIT'
[Unit]
Description=ttyview spectator tmux session (Tier 2)
After=network.target
[Service]
Type=forking
User=root
ExecStartPre=-/usr/bin/tmux -L ttv-spec kill-server
ExecStart=/usr/bin/tmux -L ttv-spec new-session -d -s spec 'top'
RemainAfterExit=yes
ExecStop=/usr/bin/tmux -L ttv-spec kill-server
[Install]
WantedBy=multi-user.target
UNIT

echo '== ttyview-daemon (Tier 2 read-only spectator) =='
sudo tee /etc/systemd/system/ttyview-spectator.service >/dev/null <<'UNIT'
[Unit]
Description=ttyview-daemon read-only spectator (Tier 2)
After=ttyview-spectator-tmux.service
Requires=ttyview-spectator-tmux.service
[Service]
User=root
ExecStart=/usr/local/bin/ttyview-daemon --bind 127.0.0.1:8081 --socket ttv-spec --read-only
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

echo '== ttyview-sandbox (Tier 3 broker) =='
sudo tee /etc/systemd/system/ttyview-sandbox.service >/dev/null <<'UNIT'
[Unit]
Description=ttyview-sandbox per-visitor broker (Tier 3)
After=network.target
[Service]
User=root
ExecStart=/usr/local/bin/ttyview-sandbox --bind 127.0.0.1:8082 --daemon-bin /usr/local/bin/ttyview-daemon
Restart=always
RestartSec=3
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
UNIT

echo '== Caddy reverse-proxy =='
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${EXTERNAL_IP}.sslip.io {
    encode gzip
    handle_path /spectator/* {
        reverse_proxy 127.0.0.1:8081
    }
    handle /spectator {
        redir /spectator/ 308
    }
    handle_path /sandbox/* {
        reverse_proxy 127.0.0.1:8082
    }
    handle /sandbox {
        redir /sandbox/ 308
    }
    handle / {
        respond \"<!doctype html><html><head><meta charset=utf-8><title>ttyview demo</title><meta name=viewport content='width=device-width,initial-scale=1'><style>body{font-family:system-ui;background:#1e1e1e;color:#d4d4d4;padding:30px;line-height:1.5;max-width:640px;margin:auto}h1{color:#6ed29a}a{color:#6ed29a}</style></head><body><h1>ttyview demo</h1><p>Two ways in:</p><ul><li><a href=/spectator/>Spectator</a> — a real tmux session (top running) you can watch live but not interact with.</li><li><a href=/sandbox/>Sandbox</a> — spin up your own ephemeral shell, type into it, install plugins. Self-destructs after 15 min idle.</li></ul></body></html>\" 200
    }
}
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ttyview-spectator-tmux.service ttyview-spectator.service ttyview-sandbox.service
sudo systemctl reload caddy
echo '== status =='
systemctl is-active ttyview-spectator-tmux.service ttyview-spectator.service ttyview-sandbox.service caddy
"

echo
echo "==================================================================="
echo "All deployed. Browse to:"
echo "  https://${HOSTNAME}/             — landing page"
echo "  https://${HOSTNAME}/spectator/   — Tier 2 (read-only top)"
echo "  https://${HOSTNAME}/sandbox/     — Tier 3 (per-visitor sandbox)"
echo "==================================================================="
