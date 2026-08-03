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
| URL | `http://<nas>:8427/` (HTTP basic auth) |
| Compose project | `/volume1/docker/authoragent` |
| Build context | `/volume1/docker/authoragent-app` |
| Image | `localhost:5555/authoragent:<package.json version>` |
| Manuscripts | `/volume1/docker/authoragent/workspace` |
| Credential vault | `/volume1/docker/authoragent/vault` |

Read the generated login on the NAS — never copy it into a ticket or comment
(ALP-1009):

```bash
ssh alpha-nas-lan 'grep AUTHORAGENT_BASIC /volume1/docker/authoragent/.env'
```

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

Each of these was hit for real while landing ALP-1725:

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

## Recovering a wedged data dir

If the write probe fails, a leftover ACL is on a dir the deploy identity no
longer owns and cannot strip. Delete it through a root container and redeploy —
**back up `workspace` first, it holds manuscripts**:

```bash
ssh alpha-nas-lan 'PATH=/usr/local/bin:$PATH docker run --rm --user 0:0 \
  -v /volume1/docker/authoragent:/p alpine rm -rf /p/vault'
```
