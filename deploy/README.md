# Production deployment

Production runs the application as the locked `yeast-win` account. A systemd socket starts the Python
deployment hook as `yeast-deploy` only while a deployment is being requested or executed. Repository code
never runs as root. The deploy account has permission to run exactly
`systemctl restart yeast-win.service` through `/etc/sudoers.d/yeast-win-deploy`.

## One-time host provisioning

From a reviewed checkout on the target host, run:

```sh
make provision
```

Do not run `sudo make provision`. The target invokes sudo for individual installation operations so the
rest of Make and its prerequisites remain unprivileged. Provisioning is idempotent and preserves existing
environment files and deploy credentials.

Provisioning prints an SSH public key. Add it to the `keredson/yeast.win` GitHub repository as a read-only
deploy key. Test access and perform the first release with:

```sh
sudo -H -u yeast-deploy git --git-dir=/var/lib/yeast-deploy/repository.git fetch origin main
make deploy
```

The application and deployment hook use Unix sockets and do not open TCP ports. Configure the existing
Cloudflare Tunnel with these published applications:

- `yeast.win` -> `unix:/run/yeast-win/app.sock`
- `deploy.yeast.win` -> `unix:/run/yeast-deploy/hook.sock`

Protect the deployment hostname with a Cloudflare Access service-token policy. Create a service token for
GitHub Actions, then add these secrets to a GitHub `production` environment:

- `YEAST_DEPLOY_SECRET`: the value stored in `/etc/yeast-win/deploy-hook.env`
- `CF_ACCESS_CLIENT_ID`: the Access service token client ID
- `CF_ACCESS_CLIENT_SECRET`: the Access service token client secret

Set the production environment variable `YEAST_DEPLOY_URL` to `https://deploy.yeast.win`. Read the local
HMAC secret for initial GitHub configuration with:

```sh
sudo sed -n 's/^YEAST_DEPLOY_SECRET=//p' /etc/yeast-win/deploy-hook.env
```

## Operation

A push to `main` runs the TypeScript tests, Python hook tests, typecheck, and production build on a
GitHub-hosted runner. After they pass, the workflow signs the commit and posts it through Cloudflare
Access. The local hook accepts only the current `origin/main`, builds a versioned release beneath
`/opt/yeast-win/releases`, atomically changes `/opt/yeast-win/current`, and restarts the application.

Useful commands:

```sh
systemctl status yeast-win.service yeast-deploy.socket
journalctl -u yeast-win.service -u yeast-deploy-hook.service
ls -l /opt/yeast-win/current
curl --fail --unix-socket /run/yeast-win/app.sock http://localhost/api/healthz
```

Failed releases are not rolled back automatically. The release symlink and journal remain available for
diagnosis, and a corrected push can deploy and restart the service.
