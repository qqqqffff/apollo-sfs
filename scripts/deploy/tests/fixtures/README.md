# Probe fixtures

`probe KEY -- cmd…` prints `<fixture dir>/KEY` (exit code from `KEY.rc`,
default 0) when `APOLLO_DEPLOY_FIXTURES` points at a fixture dir. The harness
runs with `APOLLO_FIXTURES_STRICT=1`, so every probe a scenario reaches needs a
fixture (missing keys are listed in the scenario failure).

A scenario's fixture dir is usually `fixtures/<scenario>/` assembled from
shared files in `fixtures/common/` (see each scenario script). `mgr-<op>` files
are replayed as `_remote` envelopes for `mgr <op>`; `mgr-reachable.rc` answers
`mgr_reachable`. Requests the node would have sent are kept under
`$TEST_SANDBOX/mgr-requests/` (scenarios run with --keep-sandbox to inspect).

## Live files

Under fixtures, every "live" file a run reads (`/etc/fstab`, `/etc/hosts`,
`/etc/docker/daemon.json`, `cluster/labels.json`, …) comes from
`<fixture dir>/fs/<absolute path>` (absent = the file doesn't exist), so a
scenario never sees the developer's real `/etc`. The manager's `.env` comes from
`<fixture dir>/dotenv` (a FAKE one — never copy the real `.env`). Directory
trees: `sysroot/` (for `/sys/block/*/holders`), `hostroot/` (for the metrics
preview), `cluster-nodes/` (node records on a manager).

## Probe key families

| Key | Command it replaces | Area |
|---|---|---|
| `hostname` | `hostname` | core |
| `ip-route-default`, `ip-addr-<iface>` | `ip -4 route show default`, `ip -4 -o addr show dev <iface>` | core |
| `dpkg-<pkg>`, `docker-version`, `id-groups-<user>`, `uname-m`, `uname-r`, `os-release`, `python-version` | package / host facts | system |
| `docker-swarm-state`, `docker-swarm-control`, `docker-unit`, `dockerd-validate`, `drivetemp-loaded` | swarm / dockerd / modules | system |
| `nodestatus-installed-hash`, `nodestatus-active`, `nodestatus-unit-present`, `avahi-unit-present` | the status service | nodestatus |
| `docker-swarm-json`, `avahi-browse`, `scan-2377-<net>`, `tcp-<ip>-<port>` | discovery | cluster |
| `ssh-pubkey-<user>`, `ssh-known-<host>`, `ssh-keyscan-<host>`, `ssh-fingerprint-<host>` | ssh setup | cluster |
| `docker-nodes-json`, `docker-node-ls`, `docker-node-labels-<host>`, `docker-join-token-<role>`, `docker-node-addr`, `docker-svc-replicas-<svc>`, `docker-svc-node-minio*` | manager ops | cluster |
| `lsblk-json`, `proc-swaps`, `etc-crypttab`, `proc-mountinfo`, `disk-by-id`, `lsblk-identity-<dev>`, `mountpoint-<path>`, `findmnt-*`, `dir-exists-<path>`, `df-used-<path>` | drives / roles | drives, roles |
| `docker-service-names`, `docker-stack-services*`, `docker-node-tiers`, `docker-db-app-id`, `psql-<query>`, `docker-nodes-apollo-manager`, `docker-nodes-managers`, `disk-stats-legacy`, `docker-stack-config-supported`, `docker-stack-config`, `docker-svc-constraints-<svc>`, `docker-svc-image-<svc>`, `bind-source-<path>` (repo paths as `repo/…`), `docker-node-ps-<host>` | stack | stack |
| `docker-node-state-<host>`, `docker-node-ps-state-<host>`, `docker-ps-services`, `docker-ps-unhealthy`, `http-*` | health / heartbeat | health |
| `nginx-version`, `tls-*`, `geoip-db-exists`, `fail2ban-jail`, `registry-running`, `binfmt-*`, `public-ip`, `ufw-status`, `docker-api-env`, `docker-keycloak-*` | manager infra | manager |
| `buildx-version`, `buildx-inspect-<name>` | release | release |
| `du-<item>`, `docker-db-app-id`, `docker-db-keycloak-id`, `psql-handover-counts-*`, `ls-<dir>`, `df-avail-repo` | handover | handover |
| `mgr-<op>` (+ `.rc`), `mgr-reachable.rc` | `_remote <op>` envelopes over ssh | remote |
