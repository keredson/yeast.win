#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_url="$(git -C "$root_dir" config --get remote.origin.url)"
deploy_home=/var/lib/yeast-deploy
app_home=/var/lib/yeast-win
repository="$deploy_home/repository.git"
bundle=""
temporary_files=()

cleanup() {
  if [[ -n "$bundle" ]]; then rm -f "$bundle"; fi
  for file in "${temporary_files[@]}"; do rm -f "$file"; done
}
trap cleanup EXIT

for command in git node python3 corepack curl unzip flock sudo visudo systemctl ssh-keygen openssl \
  getent useradd install sed; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

if [[ "$(uname -s)" != Linux ]]; then
  echo "provisioning currently supports systemd-based Linux hosts only" >&2
  exit 1
fi

sudo -v

if ! getent passwd yeast-win >/dev/null; then
  sudo useradd --system --user-group --home-dir "$app_home" --shell /usr/sbin/nologin yeast-win
fi
if ! getent passwd yeast-deploy >/dev/null; then
  sudo useradd --system --user-group --home-dir "$deploy_home" --shell /usr/sbin/nologin yeast-deploy
fi

sudo install -d -o yeast-win -g yeast-win -m 0700 "$app_home" "$app_home/data"
sudo install -d -o yeast-deploy -g yeast-deploy -m 0755 /opt/yeast-win /opt/yeast-win/releases
sudo install -d -o yeast-deploy -g yeast-deploy -m 0700 \
  "$deploy_home" "$deploy_home/.cache" "$deploy_home/.ssh" "$deploy_home/status" "$deploy_home/logs"
sudo install -d -o root -g root -m 0755 /usr/local/libexec/yeast-win
sudo install -d -o root -g root -m 0755 /etc/yeast-win

sudo install -o root -g root -m 0755 "$root_dir/deploy/deploy-release" \
  /usr/local/libexec/yeast-win/deploy-release
sudo install -o root -g root -m 0755 "$root_dir/deploy/deploy_hook.py" \
  /usr/local/libexec/yeast-win/deploy_hook.py
sudo install -o root -g root -m 0644 "$root_dir/deploy/yeast-win.service" \
  /etc/systemd/system/yeast-win.service
sudo install -o root -g root -m 0644 "$root_dir/deploy/yeast-deploy.socket" \
  /etc/systemd/system/yeast-deploy.socket
sudo install -o root -g root -m 0644 "$root_dir/deploy/yeast-deploy-hook.service" \
  /etc/systemd/system/yeast-deploy-hook.service

sudo visudo -cf "$root_dir/deploy/yeast-deploy.sudoers"
sudo install -o root -g root -m 0440 "$root_dir/deploy/yeast-deploy.sudoers" \
  /etc/sudoers.d/yeast-win-deploy
sudo visudo -cf /etc/sudoers.d/yeast-win-deploy

if [[ ! -f /etc/yeast-win/app.env ]]; then
  app_env="$(mktemp)"
  temporary_files+=("$app_env")
  printf '%s\n' \
    'BREWLOG_DATA_DIR=/var/lib/yeast-win/data' \
    'BREWLOG_SOCKET=/run/yeast-win/app.sock' \
    'BREWLOG_TRUST_CLOUDFLARE=true' >"$app_env"
  sudo install -o root -g root -m 0644 "$app_env" /etc/yeast-win/app.env
fi

if [[ ! -f /etc/yeast-win/deploy-hook.env ]]; then
  hook_env="$(mktemp)"
  temporary_files+=("$hook_env")
  printf 'YEAST_DEPLOY_SECRET=%s\n' "$(openssl rand -hex 32)" >"$hook_env"
  sudo install -o root -g yeast-deploy -m 0640 "$hook_env" /etc/yeast-win/deploy-hook.env
fi

if [[ ! -d "$repository" ]]; then
  bundle="$(mktemp --suffix=.bundle)"
  git -C "$root_dir" bundle create "$bundle" --all
  chmod 0644 "$bundle"
  sudo -H -u yeast-deploy git clone --mirror "$bundle" "$repository"
fi
sudo -H -u yeast-deploy git --git-dir="$repository" remote set-url origin "$remote_url"

if [[ ! -f "$deploy_home/.ssh/id_ed25519" ]]; then
  sudo -H -u yeast-deploy ssh-keygen -q -t ed25519 -N '' \
    -C 'yeast.win deployment' -f "$deploy_home/.ssh/id_ed25519"
fi

known_hosts_source="${HOME}/.ssh/known_hosts"
if [[ -f "$known_hosts_source" ]] && ssh-keygen -F github.com -f "$known_hosts_source" >/dev/null; then
  known_hosts="$(mktemp)"
  temporary_files+=("$known_hosts")
  ssh-keygen -F github.com -f "$known_hosts_source" | sed '/^#/d' >"$known_hosts"
  sudo install -o yeast-deploy -g yeast-deploy -m 0600 "$known_hosts" "$deploy_home/.ssh/known_hosts"
else
  echo "warning: GitHub is absent from $known_hosts_source; install a verified GitHub host key before deploying" >&2
fi

sudo systemctl daemon-reload
sudo systemctl enable yeast-win.service
sudo systemctl enable --now yeast-deploy.socket

echo
echo "Provisioning complete. Add this read-only deploy key to the GitHub repository:"
sudo cat "$deploy_home/.ssh/id_ed25519.pub"
echo
echo "Then configure the production environment secrets described in deploy/README.md."
echo "After the deploy key is active, run: make deploy"
