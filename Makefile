.PHONY: provision deploy print-deploy-key catalog-pull-production catalog-push-production

provision:
	./deploy/provision.sh

deploy:
	@sha="$$(git rev-parse HEAD)"; \
	run_id="manual-$$(date -u +%Y%m%dT%H%M%SZ)"; \
	sudo -H -u yeast-deploy /usr/local/libexec/yeast-win/deploy-release "$$sha" "$$run_id"

print-deploy-key:
	sudo cat /var/lib/yeast-deploy/.ssh/id_ed25519.pub

catalog-pull-production:
	./scripts/sync-production-catalog pull

catalog-push-production:
	./scripts/sync-production-catalog push
