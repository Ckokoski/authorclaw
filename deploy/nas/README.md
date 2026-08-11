# NAS hosting (ALP-1725)

AuthorAgent runs on the Synology NAS as its own compose project, `authoragent`.
Board policy ALP-673/ALP-1025: docker workloads run on the NAS only, never on a
dev host — there is deliberately no local-docker path.

## Deploy

```bash
./scripts/deploy-nas.sh              # sync + build+push + recreate + verify
./scripts/deploy-nas.sh --dry-run    # preview, no changes
./scripts/deploy-nas.sh --help       # all flags
```

The script ships **committed HEAD** via `git archive` and refuses to run if HEAD
isn't an ancestor of `origin/main`. Uncommitted work never reaches the NAS, even
with `--allow-dirty`.

| | |
|---|---|
| URL (LAN) | `http://<nas>:8427/` (HTTP basic auth) |
| URL (Tailscale) | `http://alpha-ds1525.tail72fae3.ts.net:8427/` (same basic auth) |
| Compose project | `/volume1/docker/authoragent` |
| Build context | `/volume1/docker/authoragent-app` |
| Image | `localhost:5555/authoragent:<package.json version>` |
| Manuscripts | `/volume1/docker/authoragent/workspace` |
| Credential vault | `/volume1/docker/authoragent/vault` |

## Workspace git connection (optional)

The Connections tab can connect the manuscript workspace to a GitHub repo
(commit/push/PR/merge — see `gateway/src/services/workspace-git-sync.ts`).
That service needs a git repo ROOT that CONTAINS the workspace dir as a
subdirectory (mirroring how a local checkout has `alpha-press` as the repo
root and `books/authoragent-workspace` underneath it). The NAS only
bind-mounts `/app/workspace` and `/app/config/.vault` (see the `volumes:` in
`docker-compose.yml` above) — nothing above `/app/workspace` survives a
redeploy, so there's nowhere for a `.git` directory to live if the workspace
dir itself is the mount root.

Don't add a new bind mount for this (Synology ACL provisioning pain, see
"Things that bite on this host" below). Instead, run the existing multi-book
migration **once**, before connecting a repo:

```bash
ssh alpha-nas-lan 'docker exec authoragent npm run book -- migrate-legacy manuscript'
```

This moves the current flat `memory/`/`soul/`/`projects/`/etc. into
`/app/workspace/manuscript/` and writes `.active-book`. After that, the
already-persisted `/app/workspace` mount IS the git repo root, and
`/app/workspace/manuscript` is the workspace subdirectory — connect the
Connections tab's repo root field to `/app/workspace` (not `.../manuscript`).
Zero `docker-compose.yml` / `deploy-nas.sh` changes needed.

This is a live-instance operation — run it deliberately, not as part of a
routine deploy, and only once (running it again on an already-migrated
workspace is a no-op per `migrateLegacyWorkspace`'s backward-compat design,
but there's no reason to run it twice).

Read the generated login on the NAS — never copy it into a ticket or comment
(ALP-1009):

```bash
ssh alpha-nas-lan 'grep AUTHORAGENT_BASIC /volume1/docker/authoragent/.env'
```

## Tailscale

AuthorAgent is reachable from the tailnet as well as the LAN. `deploy-nas.sh`
reads the NAS's own MagicDNS name (never hardcoded) and registers the port with
Tailscale Serve, so it sits in `tailscale serve status` beside the other
tailnet-exposed NAS services (render-stack `:8082`, render-node-manager `:8789`).

Two things about this that are easy to get wrong:

- **The gateway must be told the tailnet origin.** `getAllowedOrigins()` builds
  its allowlist from `server.host`, which behind the proxy is the container bind
  address (`0.0.0.0`), so it cannot infer its own external origin. The deploy
  puts both the LAN and tailnet origins in `AUTHORCLAW_ALLOWED_ORIGINS`. Miss the
  tailnet one and the page still loads over Tailscale while the socket.io
  handshake 400s — chat, the orchestra view and progress all go dead, with
  nothing in the HTTP path looking wrong. Step 3b asserts that handshake for
  exactly this reason.
- **Probe the MagicDNS hostname, not the `100.x` IP.** Once Serve owns the port
  it routes by hostname, and a bare tailnet-IP request gets Serve's own 404. That
  404 is Serve answering, not AuthorAgent being down.

Serve needs Tailscale operator rights, which the sanctioned `alpha-technology`
identity has (ALP-590). A NAS without Tailscale still gets a working LAN deploy —
the tailnet steps skip rather than fail.

## Why there is a proxy in front

The gateway has **no authentication of its own** and holds an encrypted API-key
vault plus filesystem tools, which is why it binds `127.0.0.1` by default.
Publishing its port on the NAS would put an unauthenticated agent on the LAN and
tailnet.

So the gateway container publishes **no port at all**; `authoragent-proxy`
(nginx, basic auth) is the only host-published port and is the security
boundary. `deploy-nas.sh` fails the deploy unless an unauthenticated request
*and* a bad-credential request both return 401.

Do not add a `ports:` entry to the `authoragent` service — that silently
reopens the hole.

## Things that bite on this host

Each of these was hit for real — the first five while landing ALP-1725, the
last one afterwards:

- **`synoacltool` is at `/usr/syno/bin`**, which DSM leaves off the PATH for
  non-interactive ssh. Miss it and the ACL strip is a silent no-op.
- **Strip the ACL, then chmod, then chown — in that order.** `synoacltool -del`
  leaves the POSIX mode derived from the ACL (here `000`), and it refuses a
  non-root caller on a dir they no longer own, so chowning first locks you out.
- **The deploy identity is not root.** `chown` returns EPERM; the chown has to
  go through a root container.
- **No CPU CFS scheduler.** `deploy.resources.limits.cpus` is rejected at
  container create; use `mem_limit`/`cpu_shares`.
- **`htpasswd` must be world-readable.** nginx's worker runs as its own uid.
  At 640 nginx returns 500 to every request *carrying* credentials while
  requests without any are still challenged 401 — so the front door looks
  healthy and no login works.
- **A manual `docker stop` used to be permanent.** Both services ran
  `restart: unless-stopped`, which by design never restarts a container stopped
  by hand — not on daemon restart, not on reboot. AuthorAgent was stopped on
  2026-08-08 and stayed down until 08-10, silently: every other NAS stack
  restarted around it, nothing was unhealthy, it was just absent. Both services
  are `restart: always` now. Stop it on purpose and expect it back after the
  next NAS reboot.

## Recovering a wedged data dir

If the write probe fails, a leftover ACL is on a dir the deploy identity no
longer owns and cannot strip. Delete it through a root container and redeploy —
**back up `workspace` first, it holds manuscripts**:

```bash
ssh alpha-nas-lan 'PATH=/usr/local/bin:$PATH docker run --rm --user 0:0 \
  -v /volume1/docker/authoragent:/p alpine rm -rf /p/vault'
```
