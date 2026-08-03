#!/usr/bin/env bash
# Deploy AuthorAgent to the NAS (ALP-1725): sync committed HEAD, build+push its
# image to the NAS-local registry, then pull+recreate its own compose project
# and verify it comes up healthy behind the auth proxy.
#
# Board policy ALP-673/ALP-1025: docker workloads run on the NAS only, never on
# a dev host. There is deliberately no local-docker path here.
#
# Usage:
#   ./scripts/deploy-nas.sh                  # sync + build+push + up + verify
#   ./scripts/deploy-nas.sh --dry-run        # preview the sync only
#   ./scripts/deploy-nas.sh --skip-sync      # build+push + up + verify only
#   NAS_ALIAS=alpha-nas ./scripts/deploy-nas.sh   # force Tailscale
#
#   --version X.Y.Z         Override build version (default: package.json "version")
#   --dry-run               Show what would sync; skips build/push/recreate.
#   --skip-sync             Skip the sync step.
#   --allow-dirty           Allow deploy with a dirty working tree. The NAS still
#                           receives only committed HEAD (via git archive) —
#                           uncommitted work does NOT ship.
#   --allow-unpushed-head   Skip the origin/main ancestry guard. Only after
#                           verifying HEAD by hand.
#
# Deploy model (mirrors the render-* repos' deploy-nas.sh, minus the mono):
#   Step 1  sync committed HEAD -> $NAS_APP_DIR (image build context)
#   Step 1b build $REGISTRY/$IMAGE_NAME:$VERSION (+ :latest, :main) on the NAS
#           from docker/Dockerfile, push all tags
#   Step 2  provision $AUTHORAGENT_DIR (compose + nginx.conf + .env + htpasswd +
#           data dirs), bump AUTHORAGENT_TAG, pull + up -d
#   Step 3  verify /healthz through the proxy, and that / demands auth
#
# AuthorAgent runs as its OWN compose project (`authoragent`), not inside the
# render-stack mono — different product, no shared nginx/registry-tag/data-dir
# conventions. See deploy/nas/docker-compose.yml.
#
# First run provisions secrets it does not overwrite on later runs:
#   - AUTHORCLAW_VAULT_KEY   random; re-keying it orphans stored API keys
#   - basic-auth credentials random user/password + htpasswd hash
# Both land in $AUTHORAGENT_DIR/.env (chmod 600) on the NAS. Read them there:
#   ssh <nas> 'grep AUTHORAGENT_BASIC /volume1/docker/authoragent/.env'
# Never paste them into tickets, comments, or logs (ALP-1009).
#
# SSH access (ALP-590): connects via the ~/.ssh/config alias `alpha-nas-lan`
# (LAN), falling back to `alpha-nas` (Tailscale). Set NAS_ALIAS to force one.
#
# Optional env vars:
#   NAS_ALIAS           Override the ssh alias (skips the LAN/Tailscale probe)
#   NAS_APP_DIR         Remote build context (default /volume1/docker/authoragent-app)
#   AUTHORAGENT_DIR     Remote compose project dir (default /volume1/docker/authoragent)
#   AUTHORAGENT_PORT    Host port the auth proxy publishes (default 8427)
#   REGISTRY            NAS-local registry (default localhost:5555)
#   IMAGE_NAME          Registry image name (default authoragent)
#   HEALTH_TIMEOUT      Seconds to wait for health (default 90 — first boot
#                       initialises the workspace and is slower than a redeploy)
#   DEPLOY_REF          Ref HEAD must be an ancestor of (default origin/main)
#   SKIP_BUILD_PUSH     true to reuse an already-pushed image

set -euo pipefail

# shellcheck source=lib/ssh-target.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/ssh-target.sh"

# ---- Defaults ----
NAS_ALIAS="${NAS_ALIAS:-}"
NAS_APP_DIR="${NAS_APP_DIR:-/volume1/docker/authoragent-app}"
AUTHORAGENT_DIR="${AUTHORAGENT_DIR:-/volume1/docker/authoragent}"
AUTHORAGENT_PORT="${AUTHORAGENT_PORT:-8427}"
REGISTRY="${REGISTRY:-localhost:5555}"
IMAGE_NAME="${IMAGE_NAME:-authoragent}"
SKIP_BUILD_PUSH="${SKIP_BUILD_PUSH:-false}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

DRY_RUN=false
SKIP_SYNC=false
ALLOW_DIRTY=false
ALLOW_UNPUSHED_HEAD="${ALLOW_UNPUSHED_HEAD:-false}"
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
DEPLOY_VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)              DRY_RUN=true; shift ;;
    --skip-sync)            SKIP_SYNC=true; shift ;;
    --allow-dirty)          ALLOW_DIRTY=true; shift ;;
    --allow-unpushed-head)  ALLOW_UNPUSHED_HEAD=true; shift ;;
    --version)              DEPLOY_VERSION="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- Dirty-tree guard ----
# Always ship committed HEAD via git archive, so the NAS never receives
# in-flight working-tree changes regardless of --allow-dirty.
COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY_FILES="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)"
if [ -n "$DIRTY_FILES" ]; then
  if [ "$ALLOW_DIRTY" = "false" ]; then
    echo "ERROR: working tree has uncommitted changes — refusing to deploy." >&2
    echo "  Commit or stash first, or pass --allow-dirty to deploy committed HEAD" >&2
    echo "  ($COMMIT_SHA) while leaving local changes in place." >&2
    echo "" >&2
    echo "$DIRTY_FILES" | head -20 >&2
    exit 1
  fi
  echo "WARNING: working tree is dirty — deploying committed HEAD ($COMMIT_SHA) only." >&2
  echo "  Local uncommitted changes will NOT reach the NAS." >&2
  echo "" >&2
fi

# ---- Unpushed-HEAD guard ----
if [ "$ALLOW_UNPUSHED_HEAD" = "true" ]; then
  echo "WARNING: --allow-unpushed-head — skipping the $DEPLOY_REF ancestry check." >&2
  echo "  Deploying HEAD ($COMMIT_SHA) unverified against $DEPLOY_REF." >&2
  echo "" >&2
else
  DEPLOY_REMOTE="${DEPLOY_REF%%/*}"
  DEPLOY_BRANCH="${DEPLOY_REF#*/}"
  echo "== Checking HEAD against $DEPLOY_REF =="
  if ! FETCH_ERR=$(git -C "$REPO_ROOT" fetch "$DEPLOY_REMOTE" "$DEPLOY_BRANCH" --quiet 2>&1); then
    echo "ERROR: could not fetch $DEPLOY_REF to verify HEAD — refusing to deploy." >&2
    echo "$FETCH_ERR" >&2
    exit 1
  fi
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor HEAD "$DEPLOY_REF"; then
    echo "ERROR: HEAD ($COMMIT_SHA) is not an ancestor of $DEPLOY_REF — refusing to deploy." >&2
    echo "" >&2
    git -C "$REPO_ROOT" log --oneline "${DEPLOY_REF}..HEAD" | head -20 >&2
    echo "" >&2
    echo "  Merge/push HEAD into $DEPLOY_REF first, or --allow-unpushed-head after" >&2
    echo "  verifying HEAD by hand." >&2
    exit 1
  fi
  echo "  HEAD ($COMMIT_SHA) is an ancestor of $DEPLOY_REF — OK."
  echo ""
fi

SYNC_ROOT="$(mktemp -d)"
trap 'rm -rf "$SYNC_ROOT"' EXIT
git -C "$REPO_ROOT" archive HEAD | (cd "$SYNC_ROOT" && tar -x)

FULL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# Read the version from archived HEAD, not the working tree, so a dirty or
# reverted tree can never mislabel the shipped release. grep/sed rather than
# python: git-bash mktemp paths don't resolve through native Windows python.exe.
if [ -z "$DEPLOY_VERSION" ]; then
  DEPLOY_VERSION="$(grep -m1 '"version"' "$SYNC_ROOT/package.json" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
  if [ -z "$DEPLOY_VERSION" ]; then
    echo "ERROR: could not read \"version\" from HEAD:package.json; pass --version." >&2
    exit 1
  fi
fi

resolve_ssh_alias NAS_ALIAS alpha-nas-lan alpha-nas || exit 1
NAS_HOST="$(ssh_alias_hostname "$NAS_ALIAS")"
if [ -z "$NAS_HOST" ]; then
  echo "ERROR: could not resolve HostName for ssh alias '$NAS_ALIAS'." >&2
  exit 1
fi

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=3"
SSH_TARGET="$NAS_ALIAS"
# Synology's default PATH for non-interactive ssh omits both /usr/local/bin
# (docker) and /usr/syno/bin (synoacltool) — every remote command has to
# re-export it. Leaving out /usr/syno/bin makes the ACL strip below a silent
# no-op, which then shows up as an unexplained permission denial.
REMOTE_PATH='export PATH=/usr/local/bin:/usr/syno/bin:/usr/bin:/bin:$PATH'

echo "=== AuthorAgent NAS deploy ==="
echo "  version : $DEPLOY_VERSION"
echo "  source  : HEAD ($COMMIT_SHA) via git archive — working tree excluded"
echo "  build   : $SSH_TARGET:$NAS_APP_DIR"
echo "  project : $SSH_TARGET:$AUTHORAGENT_DIR"
echo "  dry-run : $DRY_RUN"
echo ""

# ---- Step 1: sync build context + compose project files ----
EXCLUDE_DIRS=(.git node_modules dist coverage)

if [ "$SKIP_SYNC" = "false" ]; then
  echo "== Step 1: syncing committed HEAD to NAS =="
  if [ "$DRY_RUN" = "true" ]; then
    echo "  [dry-run] would ship $(cd "$SYNC_ROOT" && find . -type f | wc -l) files to $NAS_APP_DIR"
    echo "  [dry-run] would install deploy/nas/{docker-compose.yml,nginx.conf} into $AUTHORAGENT_DIR"
    echo ""
    echo "Dry run complete — nothing changed on the NAS."
    exit 0
  fi

  ssh $SSH_OPTS -o StrictHostKeyChecking=accept-new "$SSH_TARGET" \
    "mkdir -p '$NAS_APP_DIR' '$AUTHORAGENT_DIR'"

  TAR_EXCLUDES=()
  for d in "${EXCLUDE_DIRS[@]}"; do TAR_EXCLUDES+=("--exclude=./$d"); done
  tar "${TAR_EXCLUDES[@]}" --exclude='.env' -czf - -C "$SYNC_ROOT" . \
    | ssh $SSH_OPTS "$SSH_TARGET" "tar -xzf - -C '$NAS_APP_DIR'"

  # The compose project dir holds runtime config + secrets; it gets only the
  # two deploy files, never the whole tree.
  ssh $SSH_OPTS "$SSH_TARGET" "$REMOTE_PATH; set -eu
    cp '$NAS_APP_DIR/deploy/nas/docker-compose.yml' '$AUTHORAGENT_DIR/docker-compose.yml'
    cp '$NAS_APP_DIR/deploy/nas/nginx.conf' '$AUTHORAGENT_DIR/nginx.conf'"

  echo "  Files synced."
else
  echo "== Step 1: skipped (--skip-sync) =="
fi

# ---- Step 1b: build + push image ----
echo ""
if [ "$SKIP_BUILD_PUSH" = "true" ]; then
  echo "== Step 1b: skipping build+push (SKIP_BUILD_PUSH=true) =="
else
  echo "== Step 1b: building and pushing ${REGISTRY}/${IMAGE_NAME}:${DEPLOY_VERSION} =="
  # shellcheck disable=SC2029
  ssh $SSH_OPTS "$SSH_TARGET" "$REMOTE_PATH; set -eu
    cd '$NAS_APP_DIR'
    if [ ! -f docker/Dockerfile ]; then
      echo 'ERROR: docker/Dockerfile missing in $NAS_APP_DIR' >&2
      exit 1
    fi
    docker build \
      --label 'org.opencontainers.image.revision=${FULL_SHA}' \
      -f docker/Dockerfile \
      -t '${REGISTRY}/${IMAGE_NAME}:${DEPLOY_VERSION}' \
      -t '${REGISTRY}/${IMAGE_NAME}:latest' \
      -t '${REGISTRY}/${IMAGE_NAME}:main' \
      .
    docker push '${REGISTRY}/${IMAGE_NAME}:${DEPLOY_VERSION}'
    docker push '${REGISTRY}/${IMAGE_NAME}:latest'
    docker push '${REGISTRY}/${IMAGE_NAME}:main'"
  echo "  Pushed :${DEPLOY_VERSION} (+ :latest, :main) — revision=${FULL_SHA}"
fi

# ---- Step 2: provision + recreate ----
echo ""
echo "== Step 2: provisioning and recreating the authoragent project =="
# shellcheck disable=SC2029
ssh $SSH_OPTS "$SSH_TARGET" "$REMOTE_PATH; set -eu
  cd '$AUTHORAGENT_DIR'
  if command -v docker-compose >/dev/null 2>&1; then COMPOSE='docker-compose'; else COMPOSE='docker compose'; fi

  touch .env && chmod 600 .env

  set_env() {  # set_env KEY VALUE — write once, never clobber
    if ! grep -q \"^\$1=\" .env; then printf '%s=%s\n' \"\$1\" \"\$2\" >> .env; fi
  }
  bump_env() { # bump_env KEY VALUE — always overwrite
    if grep -q \"^\$1=\" .env; then
      sed -i \"s|^\$1=.*|\$1=\$2|\" .env
    else
      printf '%s=%s\n' \"\$1\" \"\$2\" >> .env
    fi
  }

  # Secrets: generated once. Re-keying AUTHORCLAW_VAULT_KEY would orphan every
  # stored API key, so it is never regenerated on redeploy.
  set_env AUTHORCLAW_VAULT_KEY \"\$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')\"
  set_env AUTHORAGENT_BASIC_USER author
  set_env AUTHORAGENT_BASIC_PASSWORD \"\$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')\"

  bump_env AUTHORAGENT_TAG '${DEPLOY_VERSION}'
  bump_env AUTHORAGENT_REGISTRY '${REGISTRY}'
  bump_env AUTHORAGENT_PORT '${AUTHORAGENT_PORT}'
  bump_env AUTHORAGENT_DATA_DIR '${AUTHORAGENT_DIR}'
  bump_env AUTHORAGENT_ALLOWED_ORIGINS 'http://${NAS_HOST}:${AUTHORAGENT_PORT}'
  echo '  .env updated (AUTHORAGENT_TAG=${DEPLOY_VERSION})'

  BASIC_USER=\$(grep '^AUTHORAGENT_BASIC_USER=' .env | cut -d= -f2-)
  BASIC_PASS=\$(grep '^AUTHORAGENT_BASIC_PASSWORD=' .env | cut -d= -f2-)
  if [ ! -s htpasswd ]; then
    # No htpasswd/openssl binary on Synology DSM; the httpd image has one and is
    # already needed nowhere else, so run it throwaway.
    docker run --rm httpd:2.4-alpine htpasswd -nbB \"\$BASIC_USER\" \"\$BASIC_PASS\" > htpasswd
    chmod 640 htpasswd
    echo '  htpasswd generated'
  fi

  # Bind-mount dirs must exist AND be writable by the image's non-root user
  # before compose starts: a freshly created Synology dir inherits a restrictive
  # ACL from its parent that silently overrides POSIX mode bits (ALP-1329), and
  # the ssh identity here is not root so it cannot chown. Strip the ACL as the
  # dir's owner, then chown through a root container — the docker daemon does
  # run as root, so that is the one lever available without sudo.
  IMAGE='${REGISTRY}/${IMAGE_NAME}:${DEPLOY_VERSION}'
  mkdir -p workspace vault
  # Strip the ACL BEFORE the chown, while this identity still owns the dir —
  # synoacltool denies a non-root caller on a dir owned by someone else, so
  # doing it after the chown locks us out of our own data dir. On a redeploy
  # the dirs are already 999-owned and this fails harmlessly: the ACL was
  # stripped on first provision, and the write probe below is what actually
  # decides whether the state is good.
  for d in workspace vault; do
    if command -v synoacltool >/dev/null 2>&1; then synoacltool -del \"\$d\" >/dev/null 2>&1 || true; fi
  done
  APP_UID=\$(docker run --rm --entrypoint id \"\$IMAGE\" -u)
  APP_GID=\$(docker run --rm --entrypoint id \"\$IMAGE\" -g)
  docker run --rm --user 0:0 --entrypoint sh \
    -v \"\$PWD/workspace:/mnt/workspace\" -v \"\$PWD/vault:/mnt/vault\" \"\$IMAGE\" \
    -c \"chown -R \$APP_UID:\$APP_GID /mnt/workspace /mnt/vault\"
  echo \"  data dirs owned by \$APP_UID:\$APP_GID\"

  # Seed the empty bind mount from the image's baked workspace skeleton — the
  # mount would otherwise shadow it with an empty dir on first boot.
  if [ -z \"\$(ls -A workspace)\" ]; then
    docker run --rm --user 0:0 --entrypoint sh -v \"\$PWD/workspace:/seed\" \"\$IMAGE\" \
      -c \"cp -a /app/workspace/. /seed/ && chown -R \$APP_UID:\$APP_GID /seed\"
    echo '  workspace seeded from image'
  fi

  # Prove it rather than assume it: write as the app uid the way the container
  # will. The ACL failure mode is silent and only shows up as a crash-loop.
  if ! docker run --rm --user \"\$APP_UID:\$APP_GID\" --entrypoint sh \
      -v \"\$PWD/workspace:/w\" -v \"\$PWD/vault:/v\" \"\$IMAGE\" \
      -c 'touch /w/.write-probe /v/.write-probe && rm -f /w/.write-probe /v/.write-probe'; then
    echo \"ERROR: uid \$APP_UID cannot write the bind-mounted data dirs — refusing to start\" >&2
    echo '  (AuthorAgent would come up and then fail every save.)' >&2
    echo '  Usually a leftover Synology ACL on a dir this identity no longer owns,' >&2
    echo '  which synoacltool cannot strip. Recover by deleting the dir through a' >&2
    echo '  root container so the next deploy re-provisions it cleanly:' >&2
    echo \"    docker run --rm --user 0:0 -v '$AUTHORAGENT_DIR:/p' alpine rm -rf /p/vault /p/workspace\" >&2
    echo '  (workspace holds manuscripts — back it up before removing it.)' >&2
    exit 1
  fi
  echo '  data dirs verified writable by the app uid'

  \$COMPOSE pull
  \$COMPOSE up -d"

# ---- Step 3: verify ----
echo ""
echo "== Step 3: verifying AuthorAgent (up to ${HEALTH_TIMEOUT}s) =="
echo "   http://${NAS_HOST}:${AUTHORAGENT_PORT}/healthz -> 200?"

ELAPSED=0
INTERVAL=3
HEALTH_OK=false
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  STATUS=$(curl -o /dev/null -s -w '%{http_code}' --max-time 5 \
    "http://${NAS_HOST}:${AUTHORAGENT_PORT}/healthz" 2>/dev/null || echo 000)
  if [ "$STATUS" = "200" ]; then HEALTH_OK=true; echo "  [PASS] /healthz -> 200"; break; fi
  echo "  ... waiting (${ELAPSED}s elapsed, last status: ${STATUS})"
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

if [ "$HEALTH_OK" = "false" ]; then
  echo "" >&2
  echo "FAIL: AuthorAgent did not answer /healthz within ${HEALTH_TIMEOUT}s (last: ${STATUS:-000})." >&2
  echo "  ssh $SSH_TARGET 'PATH=/usr/local/bin:\$PATH docker logs authoragent --tail 50'" >&2
  echo "  ssh $SSH_TARGET 'PATH=/usr/local/bin:\$PATH docker logs authoragent-proxy --tail 50'" >&2
  exit 1
fi

# The whole point of the proxy: an unauthenticated request to the app itself
# must be rejected. A 200 here means the security boundary is not in place.
echo ""
echo "== Step 3a: verifying the auth boundary =="
AUTH_STATUS=$(curl -o /dev/null -s -w '%{http_code}' --max-time 5 \
  "http://${NAS_HOST}:${AUTHORAGENT_PORT}/" 2>/dev/null || echo 000)
if [ "$AUTH_STATUS" != "401" ]; then
  echo "FAIL: unauthenticated GET / returned $AUTH_STATUS, expected 401." >&2
  echo "  The gateway has no auth of its own — a non-401 here means it is exposed." >&2
  exit 1
fi
echo "  [PASS] unauthenticated GET / -> 401"

echo ""
echo "== Live container status =="
ssh $SSH_OPTS "$SSH_TARGET" "$REMOTE_PATH; docker ps --filter name=authoragent --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
echo ""
echo "SUCCESS"
echo "  AuthorAgent : http://${NAS_HOST}:${AUTHORAGENT_PORT}/  (basic auth)"
echo "  Credentials : ssh $SSH_TARGET \"grep AUTHORAGENT_BASIC $AUTHORAGENT_DIR/.env\""
