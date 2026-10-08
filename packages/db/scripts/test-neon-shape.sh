#!/usr/bin/env bash
# D#81: proves the whole migration chain applies as a Neon-shaped,
# non-superuser database owner (LOGIN CREATEROLE BYPASSRLS CREATEDB
# REPLICATION, member of neon_superuser -- but no SUPERUSER), and that the resulting schema,
# grants and role attributes match a superuser-migrated database exactly.
# See docs/ops/hosted-postgres.md for the shape this asserts and why.
#
# Follows packages/db/scripts/test-pg.sh's own throwaway-cluster pattern:
# initdb + pg_ctl a brand-new, disposable cluster in a temp dir, torn down
# on exit regardless of outcome.
#
# MIGRATIONS_DIR overrides which migrations/ directory gets applied.
# Defaults to this checkout's own packages/db/migrations. Used by the PR
# description's "fails on main" proof (criterion 1), which points this
# same script at an unmodified checkout of origin/main's migrations
# instead of ever editing main itself.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # packages/db
REPO_ROOT="$(git rev-parse --show-toplevel)"

SCRIPT_START=$SECONDS

MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(pwd)/migrations}"
MIGRATE_RUNNER_TS="$(pwd)/scripts/neon-shape-migrate.ts"
CATALOG_SQL="$(pwd)/scripts/neon-shape-catalog.sql"

PG_TMP_DIR="$(mktemp -d)"
PGDATA_DIR="$PG_TMP_DIR/data"
PG_PORT=$(( (RANDOM % 5000) + 15432 ))

cleanup() {
  pg_ctl -D "$PGDATA_DIR" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$PG_TMP_DIR"
}
trap cleanup EXIT

# 1. initdb a temp cluster as bootstrap superuser `postgres` -- used ONLY
#    to create roles/databases below and to migrate fx_super for
#    comparison. Every migration run under test connects as fx_migrator.
initdb -D "$PGDATA_DIR" -U postgres --auth=trust --no-locale >"$PG_TMP_DIR/initdb.log" 2>&1

{
  # D#81 fix round (security review, informational): socket only, no TCP
  # listener at all -- every connection below already goes through the
  # unix socket directory (`-h "$PG_TMP_DIR"` for psql,
  # `?host=${PG_TMP_DIR}` for the node-postgres URLs), so a TCP listener on
  # 127.0.0.1 served no purpose here except letting any other local user
  # connect as superuser (trust auth) for as long as this script runs.
  echo "listen_addresses = ''"
  echo "port = $PG_PORT"
  echo "unix_socket_directories = '$PG_TMP_DIR'"
} >> "$PGDATA_DIR/postgresql.conf"

pg_ctl -D "$PGDATA_DIR" -l "$PG_TMP_DIR/postgres.log" -w start

PSQL=(psql -h "$PG_TMP_DIR" -p "$PG_PORT" -X -q -v ON_ERROR_STOP=1)
MIGRATE_RUNNER=(node --experimental-strip-types "$MIGRATE_RUNNER_TS")

EXPECTED_FILES="$(ls "$MIGRATIONS_DIR"/*.sql | xargs -n1 basename | sort)"

# 2. The Neon-shaped migration role: what neon_superuser membership gives
#    the real owner (https://neon.com/docs/manage/roles) -- LOGIN CREATEROLE
#    BYPASSRLS CREATEDB REPLICATION, no SUPERUSER, and a member of a
#    neon_superuser group role. fx_neon is OWNED by it (the Neon shape); fx_super is a
#    same-schema comparison database migrated as the bootstrap superuser.
"${PSQL[@]}" -U postgres -d postgres -c \
  "CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION NOSUPERUSER;
   CREATE ROLE fx_migrator LOGIN CREATEROLE BYPASSRLS CREATEDB REPLICATION NOSUPERUSER;
   GRANT neon_superuser TO fx_migrator;"
"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_neon OWNER fx_migrator;"
"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_super;"

MEMBERSHIPS="$("${PSQL[@]}" -U postgres -d postgres -tA -c \
  "SELECT coalesce(string_agg(pg_get_userbyid(roleid), ',' ORDER BY 1), '') FROM pg_auth_members WHERE member = 'fx_migrator'::regrole;")"
if [ "$MEMBERSHIPS" != "neon_superuser" ]; then
  echo "neon-shape: fx_migrator has memberships '$MEMBERSHIPS' before migrating -- expected only neon_superuser" >&2
  exit 1
fi

FX_NEON_URL="postgres://fx_migrator@127.0.0.1:${PG_PORT}/fx_neon?host=${PG_TMP_DIR}"
FX_SUPER_URL="postgres://postgres@127.0.0.1:${PG_PORT}/fx_super?host=${PG_TMP_DIR}"

# 3. Whole chain, as fx_migrator, non-superuser.
echo "==> migrating fx_neon as fx_migrator (Neon-shaped, non-superuser)"
RESULT1="$("${MIGRATE_RUNNER[@]}" "$FX_NEON_URL" "$MIGRATIONS_DIR")"
APPLIED1_SORTED="$(echo "$RESULT1" | jq -r '.applied | sort | .[]')"
if [ "$APPLIED1_SORTED" != "$EXPECTED_FILES" ]; then
  echo "neon-shape: fx_neon's applied file list did not match the migrations dir listing" >&2
  echo "--- applied ---"; echo "$APPLIED1_SORTED" >&2
  echo "--- expected ---"; echo "$EXPECTED_FILES" >&2
  exit 1
fi

# criterion 3: schema_migrations, read back as fx_migrator, matches the
# migrations dir listing exactly.
SCHEMA_MIGRATIONS="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c \
  "SELECT filename FROM schema_migrations ORDER BY 1;")"
if [ "$SCHEMA_MIGRATIONS" != "$EXPECTED_FILES" ]; then
  echo "neon-shape: fx_neon's schema_migrations did not match the migrations dir listing" >&2
  exit 1
fi

# 4. Re-running must be a no-op.
echo "==> re-migrating fx_neon (must be a no-op)"
RESULT2="$("${MIGRATE_RUNNER[@]}" "$FX_NEON_URL" "$MIGRATIONS_DIR")"
APPLIED2_COUNT="$(echo "$RESULT2" | jq '.applied | length')"
if [ "$APPLIED2_COUNT" -ne 0 ]; then
  echo "neon-shape: second run against fx_neon was not a no-op: $RESULT2" >&2
  exit 1
fi

# 5. A second database on the same cluster -- exercises the "roles
#    already exist" branch without superuser (pg_roles is cluster-wide;
#    schema_migrations is per-database).
"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_neon2 OWNER fx_migrator;"
FX_NEON2_URL="postgres://fx_migrator@127.0.0.1:${PG_PORT}/fx_neon2?host=${PG_TMP_DIR}"
echo "==> migrating fx_neon2 as fx_migrator (roles already exist cluster-wide)"
RESULT3="$("${MIGRATE_RUNNER[@]}" "$FX_NEON2_URL" "$MIGRATIONS_DIR")"
APPLIED3_SORTED="$(echo "$RESULT3" | jq -r '.applied | sort | .[]')"
if [ "$APPLIED3_SORTED" != "$EXPECTED_FILES" ]; then
  echo "neon-shape: fx_neon2 did not apply the full migration list" >&2
  exit 1
fi

# 5b. The staging build step (apps/web/scripts/migrate-on-build.mjs), the real
#     script against the real clusters: as the Neon-shaped owner it passes the
#     shape check and finds nothing to apply; pointed at the superuser it
#     refuses before touching the (still empty) fx_super database. Skipped
#     when MIGRATIONS_DIR is overridden, because the build step always uses
#     the checkout's own migrations/.
if [ "$MIGRATIONS_DIR" = "$(pwd)/migrations" ]; then
  echo "==> migrate-on-build as fx_migrator (no-op) and as postgres (must refuse)"
  BUILD_STEP=(node --experimental-strip-types "$(pwd)/../../apps/web/scripts/migrate-on-build.mjs")
  BUILD_OUT="$(FX_MIGRATE_ON_BUILD=1 DATABASE_URL_UNPOOLED="$FX_NEON_URL" "${BUILD_STEP[@]}" 2>&1)"
  if ! grep -q "applied 0 migration(s)" <<<"$BUILD_OUT"; then
    echo "neon-shape: migrate-on-build against fx_neon was not a no-op: $BUILD_OUT" >&2
    exit 1
  fi
  if BUILD_OUT="$(FX_MIGRATE_ON_BUILD=1 DATABASE_URL_UNPOOLED="$FX_SUPER_URL" "${BUILD_STEP[@]}" 2>&1)"; then
    echo "neon-shape: migrate-on-build accepted a superuser URL" >&2
    exit 1
  fi
  if ! grep -q "is a superuser" <<<"$BUILD_OUT"; then
    echo "neon-shape: migrate-on-build refused the superuser URL for the wrong reason: $BUILD_OUT" >&2
    exit 1
  fi
  UNTOUCHED="$("${PSQL[@]}" -U postgres -d fx_super -tA -c "SELECT to_regclass('schema_migrations') IS NULL;")"
  if [ "$UNTOUCHED" != "t" ]; then
    echo "neon-shape: migrate-on-build touched fx_super before refusing" >&2
    exit 1
  fi
fi

# 6. The superuser path, for comparison -- unchanged, still exercised so
#    the diff in step 7 proves parity rather than assuming it.
echo "==> migrating fx_super as postgres (superuser, unchanged path)"
"${MIGRATE_RUNNER[@]}" "$FX_SUPER_URL" "$MIGRATIONS_DIR" >/dev/null

# 7. Schema parity + the remaining per-criterion assertions, all read
#    back from fx_neon (the Neon-shaped, already-fully-migrated database).
echo "==> diffing neon-shape-catalog.sql between fx_neon and fx_super"
"${PSQL[@]}" -U fx_migrator -d fx_neon -A -F'|' -f "$CATALOG_SQL" > "$PG_TMP_DIR/catalog_neon.txt"
"${PSQL[@]}" -U postgres -d fx_super -A -F'|' -f "$CATALOG_SQL" > "$PG_TMP_DIR/catalog_super.txt"
if ! diff -u "$PG_TMP_DIR/catalog_neon.txt" "$PG_TMP_DIR/catalog_super.txt"; then
  echo "neon-shape: schema parity check FAILED (fx_neon vs fx_super, see diff above)" >&2
  exit 1
fi

# criterion 4: role hardening holds on the Neon path.
BAD_ROLES="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('app_user','platform_ops','partner_user') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);")"
if [ -n "$BAD_ROLES" ]; then
  echo "neon-shape: role hardening violated for: $BAD_ROLES" >&2
  exit 1
fi

# The owner holds CREATEDB and REPLICATION (neon_superuser), so prove a role
# it creates with NOCREATEDB/NOREPLICATION (as fx_runner is, see
# scripts/ops/staging-role-creds.mjs) gets neither, nor any neon_superuser
# membership. Dropped again so the cluster-wide role list is unchanged.
echo "==> a role created by the CREATEDB+REPLICATION owner gets neither"
"${PSQL[@]}" -U fx_migrator -d fx_neon -c \
  "CREATE ROLE fx_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;"
PROBE="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -F'|' -c \
  "SELECT rolcreatedb, rolreplication, rolsuper, rolcreaterole, rolbypassrls, (SELECT count(*) FROM pg_auth_members WHERE member = r.oid) FROM pg_roles r WHERE rolname = 'fx_probe';")"
if [ "$PROBE" != "f|f|f|f|f|0" ]; then
  echo "neon-shape: fx_probe (created NOCREATEDB NOREPLICATION by the owner) has attributes '$PROBE' -- expected f|f|f|f|f|0" >&2
  exit 1
fi
"${PSQL[@]}" -U fx_migrator -d fx_neon -c "DROP ROLE fx_probe;"

# D#71 Correction C3 / DS-0a: criterion 8 admits a named exception --
# public.erase_discussion_content(uuid, text), owned by the dedicated
# NOLOGIN role discussion_eraser (D#7 DP-C4 adds two more, below) -- and
# only when that function's own shape holds (item 5). discussion_eraser does not exist on main's
# migrations yet (DS-1 creates it in a later PR), so every check below is
# conditional on the role/function existing and is a complete no-op today,
# per item 8.
#
# D#71 Correction C4 tightens this exception per the #151 review's six
# should-fixes (see each numbered comment below for which fix it closes).

# item 5: checks the one candidate function's own shape. Prints nothing if
# there is no candidate, or one exists under a different owner (not this
# exception -- criterion 8's normal scan below handles it, unexempted).
# Prints the function's oid if it matches name+signature+owner AND passes
# the shape checks (criterion 8 excludes that oid below). Prints
# "SHAPE_FAIL:<reason>" if it matches name+signature+owner but FAILS the
# shape checks -- the caller fails the whole script naming why, rather than
# falling through to the generic criterion-8 message. Also prints
# "SHAPE_FAIL:<reason>" (C4 should-fix 6) when a psql read in here fails or
# returns malformed output: this function runs inside a command
# substitution (`$(check_eraser_exception_shape ...)` below), so an `exit`
# in here would only kill that subshell -- the SHAPE_FAIL: sentinel is how
# a failure in here still fails the whole script, via the caller's own
# `exit` outside the substitution.
check_eraser_exception_shape() {
  local dbname="$1" candidate candidate_rc owner owner_rc
  local shape_row shape_rc secdef sp_count sp_value proacl_null bad_grantees grant_option_grantees

  # C4 should-fix 4: the candidate is selected by schema, name AND argument
  # types in SQL, so this can only ever match zero or one row -- an
  # overload used to put more than one oid into a later `WHERE oid = $1`,
  # which produced a psql syntax error and could trip the gate on a
  # harmless non-definer overload. oidvector has no direct cast from oid[]
  # (its own text representation is space-separated, not the curly-brace
  # array literal `::text` on an oid[] produces) -- array_to_string(...,
  # ' ')::oidvector round-trips through oidvector's actual input syntax
  # instead, verified against a live cluster with an overload present.
  candidate="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'erase_discussion_content'
      AND p.proargtypes = array_to_string('{uuid,text}'::regtype[]::oid[], ' ')::oidvector;" 2>&1)"
  candidate_rc=$?
  if [ $candidate_rc -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'eraser-candidate-lookup' on $dbname (exit $candidate_rc): $candidate"
    return 0
  fi
  [ -z "$candidate" ] && return 0

  owner="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = $candidate;" 2>&1)"
  owner_rc=$?
  if [ $owner_rc -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'eraser-owner-lookup' on $dbname (exit $owner_rc): $owner"
    return 0
  fi
  [ "$owner" = "discussion_eraser" ] || return 0

  # C4 should-fix 6: the shape reads folded into one query, with the exit
  # status checked explicitly right after -- errexit is not inherited
  # inside `$(...)`, so a failed psql call here used to leave the variable
  # empty and silently pass some of the checks below instead of failing
  # closed.
  # C4 should-fix 1 (CWE-269): is_grantable is checked for every non-owner
  # grantee, including platform_ops (grant_option_grantees) -- not only
  # whether the grantee is on the allowed list.
  # C4 should-fix 3 (CWE-426): the search_path VALUE is checked (sp_count,
  # sp_value), not only that some search_path entry is present.
  # C4 should-fix 5: PUBLIC (grantee oid 0) is labelled 'PUBLIC' by a CASE,
  # not the old coalesce(pg_get_userbyid(...), 'PUBLIC'), which never fired
  # because pg_get_userbyid(0) returns the string 'unknown (OID=0)', not
  # NULL.
  shape_row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT
      p.prosecdef,
      (SELECT count(*) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%'),
      coalesce((SELECT string_agg(cfg, '; ') FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%'), ''),
      (p.proacl IS NULL),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a
                WHERE a.grantee NOT IN (p.proowner, 'platform_ops'::regrole::oid)), ''),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a
                WHERE a.grantee <> p.proowner AND a.is_grantable), '')
    FROM pg_proc p WHERE p.oid = $candidate;" 2>&1)"
  shape_rc=$?
  if [ $shape_rc -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'eraser-shape-combined' on $dbname (exit $shape_rc): $shape_row"
    return 0
  fi
  if [ -z "$shape_row" ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$shape_row")" != "6" ]; then
    echo "SHAPE_FAIL:malformed shape query output for public.erase_discussion_content(uuid, text) on $dbname (expected 6 fields): [${shape_row:-empty}]"
    return 0
  fi
  IFS='|' read -r secdef sp_count sp_value proacl_null bad_grantees grant_option_grantees <<<"$shape_row"

  if [ "$secdef" != "t" ] \
    || [ "$sp_count" != "1" ] || [ "$sp_value" != "search_path=pg_catalog, public, pg_temp" ] \
    || [ "$proacl_null" = "t" ] \
    || [ -n "$bad_grantees" ] || [ -n "$grant_option_grantees" ]; then
    echo "SHAPE_FAIL:public.erase_discussion_content(uuid, text) is owned by discussion_eraser but fails the DS-0a/C4 exception shape -- prosecdef=$secdef search_path_entries=$sp_count search_path_value=[${sp_value:-none}] proacl_is_null=$proacl_null extra_execute_grantee(s)=[${bad_grantees:-none}] WITH_GRANT_OPTION_grantee(s)=[${grant_option_grantees:-none}]"
    return 0
  fi
  echo "$candidate"
}

# items 2-4: role/ownership shape of discussion_eraser itself. A no-op when
# the role does not exist (main today). Called directly (never inside a
# command substitution), so its own `exit 1` really does stop the script --
# every psql read below is followed by an explicit exit-status check for
# exactly that reason (C4 should-fix 6, "the same applies to every psql
# read check_eraser_role_shape makes"): errexit is not inherited inside
# `$(...)`, so a failed read used to leave its variable empty, and
# bad_members/migrator_inherit/owned would then silently pass (empty
# string reads as "no bad members" etc.) instead of failing closed.
check_eraser_role_shape() {
  local dbname="$1" out rc
  local role_exists attrs canlogin super createdb createrole repl bypassrls
  local eraser_usage bad_members migrator_inherit owned foreign_memberships

  # Every read below uses `rc=0; out=$(...) || rc=$?`, never a bare
  # `out=$(...); rc=$?` -- this function is called DIRECTLY (never inside
  # a command substitution), so -e IS active here (unlike
  # check_eraser_exception_shape, whose own `$(...)` wrapper at its call
  # site disables -e for everything inside it, per bash's default
  # non-inherited errexit in command substitutions). Called directly, a
  # bare `out=$(failing_cmd)` trips -e on THAT line and kills the script
  # before `rc=$?` is ever reached -- fail-closed, but silently, with none
  # of the named-check messages below. Putting the assignment on the left
  # of `||` exempts it from -e (same exemption as a command before `&&`/
  # `||`), so the real exit code still reaches `rc` and the named message
  # below actually prints. Verified empirically against bash's documented
  # (non-)inheritance of -e into command substitution subshells.
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discussion_eraser');" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-exists' (exit $rc): $out" >&2
    exit 1
  fi
  role_exists="$out"
  [ "$role_exists" = "t" ] || return 0

  # item 4: no runtime role inherits discussion_eraser's privileges.
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT pg_has_role('fx_migrator','discussion_eraser','USAGE');" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-fx_migrator-usage' (exit $rc): $out" >&2
    exit 1
  fi
  eraser_usage="$out"
  if [ "$eraser_usage" != "f" ]; then
    echo "neon-shape ($dbname): fx_migrator inherits discussion_eraser's privileges (expected f, got $eraser_usage)" >&2
    exit 1
  fi

  # item 3: role attributes -- NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  # NOREPLICATION NOBYPASSRLS (C3's ruling: NOBYPASSRLS).
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c \
    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'discussion_eraser';" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-attrs' (exit $rc): $out" >&2
    exit 1
  fi
  attrs="$out"
  IFS='|' read -r canlogin super createdb createrole repl bypassrls <<<"$attrs"
  if [ "$canlogin" != "f" ] || [ "$super" != "f" ] || [ "$createdb" != "f" ] || [ "$createrole" != "f" ] || [ "$repl" != "f" ] || [ "$bypassrls" != "f" ]; then
    echo "neon-shape ($dbname): discussion_eraser attribute(s) wrong -- rolcanlogin=$canlogin rolsuper=$super rolcreatedb=$createdb rolcreaterole=$createrole rolreplication=$repl rolbypassrls=$bypassrls (all must be f)" >&2
    exit 1
  fi

  # item 3: no member other than the migration role; that membership (if
  # any) does not inherit.
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT string_agg(DISTINCT pg_get_userbyid(member), ', ') FROM pg_auth_members WHERE roleid = 'discussion_eraser'::regrole AND member <> 'fx_migrator'::regrole;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-bad-members' (exit $rc): $out" >&2
    exit 1
  fi
  bad_members="$out"
  if [ -n "$bad_members" ]; then
    echo "neon-shape ($dbname): discussion_eraser has member(s) other than the migration role: $bad_members" >&2
    exit 1
  fi
  # fx_migrator can hold more than one pg_auth_members row here (e.g. the
  # auto-added creator/admin row from CREATE ROLE, grantor discussion_eraser
  # itself, plus an explicit self-GRANT ... WITH SET TRUE row, grantor
  # fx_migrator -- different grantors don't collapse into one row). Every
  # such row must be non-inheriting, so aggregate with bool_or rather than
  # assume a single row.
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT bool_or(inherit_option) FROM pg_auth_members WHERE roleid = 'discussion_eraser'::regrole AND member = 'fx_migrator'::regrole;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-migrator-inherit' (exit $rc): $out" >&2
    exit 1
  fi
  migrator_inherit="$out"
  if [ "$migrator_inherit" = "t" ]; then
    echo "neon-shape ($dbname): fx_migrator has an inheriting membership row in discussion_eraser (expected every such row to have inherit_option=f)" >&2
    exit 1
  fi

  # D#71 Correction C4 should-fix 2 (CWE-269): discussion_eraser must not
  # itself be a member of any OTHER role -- separate from the check above,
  # which checks who is a member OF discussion_eraser (DS-0a criterion 3,
  # unchanged). A fixture like `GRANT platform_ops TO discussion_eraser`
  # would let the definer run with platform_ops's inherited privileges too.
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c \
    "SELECT string_agg(DISTINCT pg_get_userbyid(roleid), ', ') FROM pg_auth_members WHERE member = 'discussion_eraser'::regrole;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-foreign-memberships' (exit $rc): $out" >&2
    exit 1
  fi
  foreign_memberships="$out"
  if [ -n "$foreign_memberships" ]; then
    echo "neon-shape ($dbname): discussion_eraser is a member of role(s) it must not be: $foreign_memberships" >&2
    exit 1
  fi

  # item 2: discussion_eraser owns nothing besides the one exempted
  # function (ownership check only -- item 5's shape check runs separately
  # in check_eraser_exception_shape).
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    SELECT string_agg(obj, ', ') FROM (
      SELECT 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS obj
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE pg_get_userbyid(p.proowner) = 'discussion_eraser'
        AND NOT (n.nspname = 'public' AND p.proname = 'erase_discussion_content'
                 AND (SELECT array_to_string(array_agg(format_type(t, NULL) ORDER BY ord), ' ')
                      FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) = 'uuid text')
      UNION ALL
      SELECT 'relation ' || n.nspname || '.' || c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE pg_get_userbyid(c.relowner) = 'discussion_eraser'
      UNION ALL
      SELECT 'schema ' || n.nspname
      FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = 'discussion_eraser'
      UNION ALL
      SELECT 'type ' || n.nspname || '.' || t.typname
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE pg_get_userbyid(t.typowner) = 'discussion_eraser'
    ) x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'discussion_eraser-owned-objects' (exit $rc): $out" >&2
    exit 1
  fi
  owned="$out"
  if [ -n "$owned" ]; then
    echo "neon-shape ($dbname): discussion_eraser owns object(s) beyond the one exempted function: $owned" >&2
    exit 1
  fi
}

# D#7 DP-C4a: the second named definer exemption. Owned by the NOLOGIN
# receipt_writer (no login can use or inherit it), so it is exempted by
# name and exact argument types, not by owner. Same contract as
# check_eraser_exception_shape (runs inside $(...); failures print
# SHAPE_FAIL:<reason>), but EXECUTE may go to receipt_writer_invoker ONLY.
# D#7 DP3b: called once per named definer -- `<dbname> <function> <argtypes>`
# -- decision_receipt_write (class 2/3) and decision_receipt_write_class1.
check_receipt_writer_exception_shape() {
  local dbname="$1" fname="$2" argtypes="$3" row rc=0 oid owner secdef sp_count sp_value acl_null grantees grant_opt
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT p.oid, pg_get_userbyid(p.proowner), p.prosecdef,
      (SELECT count(*) FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%'),
      coalesce((SELECT string_agg(c, '; ') FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%'), ''),
      (p.proacl IS NULL),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner), ''),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner AND a.is_grantable), '')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '$fname'
      AND p.proargtypes = array_to_string('{$argtypes}'::regtype[]::oid[], ' ')::oidvector;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'receipt-writer-shape' ($fname) on $dbname (exit $rc): $row"
    return 0
  fi
  [ -z "$row" ] && return 0
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "8" ]; then
    echo "SHAPE_FAIL:malformed shape query output for public.$fname on $dbname (expected 8 fields): [$row]"
    return 0
  fi
  IFS='|' read -r oid owner secdef sp_count sp_value acl_null grantees grant_opt <<<"$row"
  [ "$owner" = "receipt_writer" ] || return 0
  if [ "$secdef" != "t" ] \
    || [ "$sp_count" != "1" ] || [ "$sp_value" != "search_path=pg_catalog, public, pg_temp" ] \
    || [ "$acl_null" = "t" ] || [ "$grantees" != "receipt_writer_invoker" ] || [ -n "$grant_opt" ]; then
    echo "SHAPE_FAIL:public.$fname is owned by receipt_writer but fails the DP-C4 exception shape -- prosecdef=$secdef search_path_entries=$sp_count search_path_value=[${sp_value:-none}] proacl_is_null=$acl_null execute_grantee(s)=[${grantees:-none}] (must be exactly receipt_writer_invoker) WITH_GRANT_OPTION_grantee(s)=[${grant_opt:-none}]"
    return 0
  fi
  echo "$oid"
}

# D#7 DP-C4a items 7-11: role shape of receipt_writer. A no-op when the role
# does not exist. Called directly (never in $(...)), so `exit 1` stops the
# script; the psql status is checked explicitly and malformed output fails.
check_receipt_writer_role_shape() {
  local dbname="$1" out rc=0 exists
  local canlogin super createdb createrole repl bypassrls bad_members migrator_bad usage foreign owned create_priv
  exists="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipt_writer');" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'receipt_writer-exists' (exit $rc): $exists" >&2
    exit 1
  fi
  [ "$exists" = "t" ] || return 0
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(member), ', ') FROM pg_auth_members
                WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole), ''),
      coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members
                WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false),
      pg_has_role('fx_migrator', 'receipt_writer', 'USAGE'),
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(roleid), ', ') FROM pg_auth_members WHERE member = r.oid), ''),
      coalesce((SELECT string_agg(obj, ', ') FROM (
        SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS obj FROM pg_proc p
          WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND (
            (p.proname = 'decision_receipt_write'
              AND p.proargtypes = array_to_string('{text,text,text,text,integer,jsonb,uuid,uuid,integer}'::regtype[]::oid[], ' ')::oidvector)
            OR (p.proname = 'decision_receipt_write_class1'
              AND p.proargtypes = array_to_string('{text,text,text,integer,jsonb,uuid,uuid,integer}'::regtype[]::oid[], ' ')::oidvector)
            OR (p.proname = 'decision_ask_raise'
              AND p.proargtypes = array_to_string('{text,text,uuid,uuid,jsonb,text,text,jsonb,integer,text}'::regtype[]::oid[], ' ')::oidvector)))
        UNION ALL SELECT 'relation ' || c.relname FROM pg_class c WHERE c.relowner = r.oid
        UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = r.oid
        UNION ALL SELECT 'type ' || t.typname FROM pg_type t WHERE t.typowner = r.oid) x), ''),
      has_schema_privilege('receipt_writer', 'public', 'CREATE')
    FROM pg_roles r WHERE r.rolname = 'receipt_writer';" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'receipt_writer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$out")" != "12" ]; then
    echo "neon-shape ($dbname): malformed receipt_writer role-shape output (expected 12 fields): [${out:-empty}]" >&2
    exit 1
  fi
  IFS='|' read -r canlogin super createdb createrole repl bypassrls bad_members migrator_bad usage foreign owned create_priv <<<"$out"
  if [ "$canlogin$super$createdb$createrole$repl$bypassrls" != "ffffff" ]; then
    echo "neon-shape ($dbname): receipt_writer attribute(s) wrong (item 7) -- rolcanlogin=$canlogin rolsuper=$super rolcreatedb=$createdb rolcreaterole=$createrole rolreplication=$repl rolbypassrls=$bypassrls (all must be f)" >&2
    exit 1
  fi
  if [ -n "$bad_members" ]; then
    echo "neon-shape ($dbname): receipt_writer has member(s) other than the migration role (item 8): $bad_members" >&2
    exit 1
  fi
  if [ "$migrator_bad" != "f" ] || [ "$usage" != "f" ]; then
    echo "neon-shape ($dbname): fx_migrator holds a live receipt_writer membership (item 8) -- inherit_or_set_option=$migrator_bad pg_has_role_usage=$usage (both must be f)" >&2
    exit 1
  fi
  if [ -n "$foreign" ]; then
    echo "neon-shape ($dbname): receipt_writer is a member of role(s) it must not be (item 9): $foreign" >&2
    exit 1
  fi
  if [ -n "$owned" ]; then
    echo "neon-shape ($dbname): receipt_writer owns object(s) beyond the three exempted functions (item 10): $owned" >&2
    exit 1
  fi
  if [ "$create_priv" != "f" ]; then
    echo "neon-shape ($dbname): receipt_writer still has CREATE on schema public (item 11)" >&2
    exit 1
  fi
}

# D#2 CARRY-17-Q: the one SECURITY DEFINER owned by metering_reporter, matched
# by exact name and signature. Prints the function oid when it is owned by
# metering_reporter and has the expected shape; prints nothing when it is not
# owned by metering_reporter (the generic owner check then rejects it).
check_metering_reporter_exception_shape() {
  local dbname="$1" row rc=0 oid owner secdef sp_value acl_null grantees grant_opt
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT p.oid, pg_get_userbyid(p.proowner), p.prosecdef,
      coalesce((SELECT string_agg(c, '; ') FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c), ''),
      (p.proacl IS NULL),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner), ''),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner AND a.is_grantable), '')
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'run_metering_flag_rate'
      AND p.proargtypes = array_to_string('{integer}'::regtype[]::oid[], ' ')::oidvector;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'metering-reporter-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  [ -z "$row" ] && return 0
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "7" ]; then
    echo "SHAPE_FAIL:malformed shape query output for public.run_metering_flag_rate on $dbname (expected 7 fields): [$row]"
    return 0
  fi
  IFS='|' read -r oid owner secdef sp_value acl_null grantees grant_opt <<<"$row"
  [ "$owner" = "metering_reporter" ] || return 0
  if [ "$secdef" != "t" ] || [ "$sp_value" != "search_path=pg_catalog, public, pg_temp" ] \
    || [ "$acl_null" = "t" ] || [ "$grantees" != "platform_ops" ] || [ -n "$grant_opt" ]; then
    echo "SHAPE_FAIL:public.run_metering_flag_rate(integer) is owned by metering_reporter but fails the exception shape -- prosecdef=$secdef config=[${sp_value:-none}] proacl_is_null=$acl_null execute_grantee(s)=[${grantees:-none}] (must be exactly platform_ops) WITH_GRANT_OPTION_grantee(s)=[${grant_opt:-none}]"
    return 0
  fi
  echo "$oid"
}

# D#2 CARRY-17-Q: role shape of metering_reporter. A no-op when the role does
# not exist. NOLOGIN and unprivileged, no memberships in either direction (the
# migrator's ownership bracket is gone), table privileges exactly the five
# run_events columns the definer reads and nothing else, owns only the one
# function, and has no CREATE on public.
check_metering_reporter_role_shape() {
  local dbname="$1" out rc=0 exists
  local canlogin super createdb createrole repl bypassrls members migrator_bad foreign privs owned create_priv
  exists="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metering_reporter');" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'metering_reporter-exists' (exit $rc): $exists" >&2
    exit 1
  fi
  [ "$exists" = "t" ] || return 0
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(member), ', ') FROM pg_auth_members
                WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole), ''),
      coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members
                WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
        OR pg_has_role('fx_migrator', 'metering_reporter', 'USAGE'),
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(roleid), ', ') FROM pg_auth_members WHERE member = r.oid), ''),
      coalesce((SELECT string_agg(x,', ' ORDER BY x) FROM (
        SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x
          FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid
        UNION ALL
        SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
          FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE a.grantee = r.oid
        UNION ALL
        SELECT 'schema ' || n.nspname || ' ' || a.privilege_type
          FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = r.oid AND n.nspname = 'public') y), ''),
      coalesce((SELECT string_agg(obj, ', ') FROM (
        SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS obj FROM pg_proc p
          WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname = 'run_metering_flag_rate'
            AND p.proargtypes = array_to_string('{integer}'::regtype[]::oid[], ' ')::oidvector)
        UNION ALL SELECT 'relation ' || c.relname FROM pg_class c WHERE c.relowner = r.oid
        UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = r.oid
        UNION ALL SELECT 'type ' || t.typname FROM pg_type t WHERE t.typowner = r.oid) z), ''),
      has_schema_privilege('metering_reporter', 'public', 'CREATE')
    FROM pg_roles r WHERE r.rolname = 'metering_reporter';" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'metering_reporter-shape' (exit $rc): $out" >&2
    exit 1
  fi
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$out")" != "12" ]; then
    echo "neon-shape ($dbname): malformed metering_reporter role-shape output (expected 12 fields): [${out:-empty}]" >&2
    exit 1
  fi
  IFS='|' read -r canlogin super createdb createrole repl bypassrls members migrator_bad foreign privs owned create_priv <<<"$out"
  if [ "$canlogin$super$createdb$createrole$repl$bypassrls" != "ffffff" ]; then
    echo "neon-shape ($dbname): metering_reporter attribute(s) wrong -- rolcanlogin=$canlogin rolsuper=$super rolcreatedb=$createdb rolcreaterole=$createrole rolreplication=$repl rolbypassrls=$bypassrls (all must be f)" >&2
    exit 1
  fi
  if [ -n "$members" ]; then
    echo "neon-shape ($dbname): metering_reporter has member(s) other than the migration role: $members" >&2
    exit 1
  fi
  # The migration role keeps only the ADMIN-only membership Postgres gives the
  # creator of a role; no inherit, no SET, no live USAGE (the bracket is revoked).
  if [ "$migrator_bad" != "t" ] && [ "$migrator_bad" != "f" ]; then
    echo "neon-shape ($dbname): unreadable migrator membership state for metering_reporter: [$migrator_bad]" >&2
    exit 1
  fi
  if [ "$migrator_bad" = "t" ]; then
    echo "neon-shape ($dbname): fx_migrator holds a live metering_reporter membership (inherit, SET or USAGE)" >&2
    exit 1
  fi
  if [ -n "$foreign" ]; then
    echo "neon-shape ($dbname): metering_reporter is a member of role(s): $foreign (must be none)" >&2
    exit 1
  fi
  local expected="column run_events.created_at SELECT, column run_events.kind SELECT, column run_events.payload SELECT, column run_events.run_id SELECT, column run_events.seq SELECT"
  if [ "$privs" != "$expected" ]; then
    echo "neon-shape ($dbname): metering_reporter privileges are [${privs:-none}], must be exactly [$expected]" >&2
    exit 1
  fi
  if [ -n "$owned" ]; then
    echo "neon-shape ($dbname): metering_reporter owns object(s) beyond run_metering_flag_rate(integer): $owned" >&2
    exit 1
  fi
  if [ "$create_priv" != "f" ]; then
    echo "neon-shape ($dbname): metering_reporter still has CREATE on schema public" >&2
    exit 1
  fi
}

# H1a: the one SECURITY DEFINER owned by error_event_writer (error_event_record), matched by exact name and
# signature. Prints the function oid when it is owned by error_event_writer and has the expected shape; prints
# nothing when it is not owned by error_event_writer (the generic owner check then rejects it).
check_error_event_writer_exception_shape() {
  local dbname="$1" row rc=0 oid owner secdef sp_value acl_null grantees grant_opt
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT p.oid, pg_get_userbyid(p.proowner), p.prosecdef,
      coalesce((SELECT string_agg(c, '; ') FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c), ''),
      (p.proacl IS NULL),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner), ''),
      coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
                FROM aclexplode(coalesce(p.proacl, '{}'::aclitem[])) a WHERE a.grantee <> p.proowner AND a.is_grantable), '')
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'error_event_record'
      AND p.proargtypes = array_to_string('{text,text,text,text,integer}'::regtype[]::oid[], ' ')::oidvector;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SHAPE_FAIL:psql failed for check 'error-event-writer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  [ -z "$row" ] && return 0
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "7" ]; then
    echo "SHAPE_FAIL:malformed shape query output for public.error_event_record on $dbname (expected 7 fields): [$row]"
    return 0
  fi
  IFS='|' read -r oid owner secdef sp_value acl_null grantees grant_opt <<<"$row"
  [ "$owner" = "error_event_writer" ] || return 0
  if [ "$secdef" != "t" ] || [ "$sp_value" != "search_path=pg_catalog, public, pg_temp" ] \
    || [ "$acl_null" = "t" ] || [ "$grantees" != "app_user" ] || [ -n "$grant_opt" ]; then
    echo "SHAPE_FAIL:public.error_event_record is owned by error_event_writer but fails the exception shape -- prosecdef=$secdef config=[${sp_value:-none}] proacl_is_null=$acl_null execute_grantee(s)=[${grantees:-none}] (must be exactly app_user) WITH_GRANT_OPTION_grantee(s)=[${grant_opt:-none}]"
    return 0
  fi
  echo "$oid"
}

# H1a: role shape of error_event_writer. A no-op when the role does not exist. NOLOGIN and unprivileged, no
# memberships in either direction (the migrator's ownership bracket is gone), table privileges exactly SELECT,
# INSERT and UPDATE on error_events and nothing else, owns only the one function, and has no CREATE on public.
check_error_event_writer_role_shape() {
  local dbname="$1" out rc=0 exists
  local canlogin super createdb createrole repl bypassrls members migrator_bad foreign privs owned create_priv
  exists="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'error_event_writer');" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'error_event_writer-exists' (exit $rc): $exists" >&2
    exit 1
  fi
  [ "$exists" = "t" ] || return 0
  rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(member), ', ') FROM pg_auth_members
                WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole), ''),
      coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members
                WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
        OR pg_has_role('fx_migrator', 'error_event_writer', 'USAGE'),
      coalesce((SELECT string_agg(DISTINCT pg_get_userbyid(roleid), ', ') FROM pg_auth_members WHERE member = r.oid), ''),
      coalesce((SELECT string_agg(x,', ' ORDER BY x) FROM (
        SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x
          FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid
        UNION ALL
        SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
          FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE a.grantee = r.oid
        UNION ALL
        SELECT 'schema ' || n.nspname || ' ' || a.privilege_type
          FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = r.oid AND n.nspname = 'public') y), ''),
      coalesce((SELECT string_agg(obj, ', ') FROM (
        SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS obj FROM pg_proc p
          WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname = 'error_event_record'
            AND p.proargtypes = array_to_string('{text,text,text,text,integer}'::regtype[]::oid[], ' ')::oidvector)
        UNION ALL SELECT 'relation ' || c.relname FROM pg_class c WHERE c.relowner = r.oid
        UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = r.oid
        UNION ALL SELECT 'type ' || t.typname FROM pg_type t WHERE t.typowner = r.oid) z), ''),
      has_schema_privilege('error_event_writer', 'public', 'CREATE')
    FROM pg_roles r WHERE r.rolname = 'error_event_writer';" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'error_event_writer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  if [ "$(awk -F'|' '{print NF; exit}' <<<"$out")" != "12" ]; then
    echo "neon-shape ($dbname): malformed error_event_writer role-shape output (expected 12 fields): [${out:-empty}]" >&2
    exit 1
  fi
  IFS='|' read -r canlogin super createdb createrole repl bypassrls members migrator_bad foreign privs owned create_priv <<<"$out"
  if [ "$canlogin$super$createdb$createrole$repl$bypassrls" != "ffffff" ]; then
    echo "neon-shape ($dbname): error_event_writer attribute(s) wrong -- rolcanlogin=$canlogin rolsuper=$super rolcreatedb=$createdb rolcreaterole=$createrole rolreplication=$repl rolbypassrls=$bypassrls (all must be f)" >&2
    exit 1
  fi
  if [ -n "$members" ]; then
    echo "neon-shape ($dbname): error_event_writer has member(s) other than the migration role: $members" >&2
    exit 1
  fi
  if [ "$migrator_bad" != "f" ]; then
    echo "neon-shape ($dbname): fx_migrator holds a live error_event_writer membership (inherit, SET or USAGE): [$migrator_bad]" >&2
    exit 1
  fi
  if [ -n "$foreign" ]; then
    echo "neon-shape ($dbname): error_event_writer is a member of role(s): $foreign (must be none)" >&2
    exit 1
  fi
  local expected="table error_events INSERT, table error_events SELECT, table error_events UPDATE"
  if [ "$privs" != "$expected" ]; then
    echo "neon-shape ($dbname): error_event_writer privileges are [${privs:-none}], must be exactly [$expected]" >&2
    exit 1
  fi
  if [ -n "$owned" ]; then
    echo "neon-shape ($dbname): error_event_writer owns object(s) beyond error_event_record: $owned" >&2
    exit 1
  fi
  if [ "$create_priv" != "f" ]; then
    echo "neon-shape ($dbname): error_event_writer still has CREATE on schema public" >&2
    exit 1
  fi
}

# D#2 hardening (0720, 0721): the SECURITY DEFINER functions owned by guard_definer, matched by exact name. Prints their oids,
# comma separated, when each is in one of two shapes. The two trigger helpers (0720): pinned to search_path=pg_catalog, public,
# pg_temp and executable by exactly app_user, platform_ops and the migration role (the table owner, whose FK cascades fire the
# triggers) with no grant option. The seven membership/partner authorization helpers (0721): search_path=public, pg_temp as
# originally declared, EXECUTE for platform_ops and only app_user/partner_user besides, nothing for PUBLIC, no grant option;
# SHAPE_FAIL:<n>
# when any is not; nothing when the role owns none (the generic owner check then rejects anything else).
check_guard_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, ((p.proname IN ('runner_revoke_on_member_change_apply', 'model_connections_onboarding_mark_apply')
        AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable AND a.grantee <> p.proowner)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee) ORDER BY pg_get_userbyid(a.grantee))
               FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0) = ARRAY['app_user', 'fx_migrator', 'platform_ops']::name[]
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
        OR (p.proname IN ('current_member_role', 'current_member_user_id', 'current_member_email', 'has_open_invitation',
                          'partner_account_visible', 'has_active_support_grant', 'support_grant_matches')
        AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable AND a.grantee <> p.proowner)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND pg_get_userbyid(a.grantee) NOT IN ('app_user', 'platform_ops', 'partner_user'))
        AND has_function_privilege('platform_ops', p.oid, 'EXECUTE'))) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'guard_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'guard-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by guard_definer fail the exception shape (not one of its two helpers, a loose search_path, or EXECUTE for anyone but app_user, platform_ops and the migration role)"
    return 0
  fi
  echo "$oids"
}

# D#2 trigger-function hardening (0720): role shape of guard_definer. A no-op when the role does not exist. NOLOGIN and
# unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly the
# column grants of 0720 and 0721 plus USAGE on public, owning only its helpers, no CREATE on public.
check_guard_definer_role_shape() {
  local dbname="$1" out rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'guard_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    want(x) AS (VALUES ('column account_members.account_id SELECT'), ('column account_members.user_id SELECT'), ('column account_members.role SELECT'),
      ('column runners.id SELECT'), ('column runners.account_id SELECT'), ('column runners.registered_by SELECT'), ('column runners.revoked_at SELECT'),
      ('column runners.revoked_at UPDATE'), ('column runners.revoked_reason UPDATE'),
      ('column audit_log.account_id INSERT'), ('column audit_log.actor INSERT'), ('column audit_log.action INSERT'), ('column audit_log.payload INSERT'), ('column audit_log.created_at INSERT'),
      ('column model_connections.account_id SELECT'), ('column model_connections.status SELECT'),
      ('column accounts.id SELECT'), ('column accounts.onboarding_key_ok_at SELECT'), ('column accounts.onboarding_key_ok_at UPDATE'),
      ('column users.id SELECT'), ('column users.email SELECT'),
      ('column invitations.account_id SELECT'), ('column invitations.email SELECT'), ('column invitations.role SELECT'),
      ('column invitations.accepted_at SELECT'), ('column invitations.expires_at SELECT'), ('column invitations.invited_by SELECT'),
      ('column accounts.partner_id SELECT'), ('column accounts.deleted_at SELECT'),
      ('column support_grants.id SELECT'), ('column support_grants.account_id SELECT'), ('column support_grants.grantee_kind SELECT'),
      ('column support_grants.grantee_partner_id SELECT'), ('column support_grants.revoked_at SELECT'), ('column support_grants.expires_at SELECT'),
      ('schema public USAGE'))
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'guard_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN EXISTS (SELECT 1 FROM held WHERE x NOT IN (SELECT x FROM want)) OR EXISTS (SELECT 1 FROM want WHERE x NOT IN (SELECT x FROM held))
           THEN 'privileges are not exactly the ones granted by 0720 and 0721: extra=[' || coalesce((SELECT string_agg(x, ', ') FROM held WHERE x NOT IN (SELECT x FROM want)), '') || '] missing=[' || coalesce((SELECT string_agg(x, ', ') FROM want WHERE x NOT IN (SELECT x FROM held)), '') || ']' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname IN
              ('runner_revoke_on_member_change_apply', 'model_connections_onboarding_mark_apply', 'current_member_role', 'current_member_user_id',
               'current_member_email', 'has_open_invitation', 'partner_account_visible', 'has_active_support_grant', 'support_grant_matches')))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              THEN 'owns an object beyond its helpers' END,
      CASE WHEN has_schema_privilege('guard_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'guard_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  if [ -n "$out" ]; then
    echo "neon-shape ($dbname): guard_definer role shape wrong: $out" >&2
    exit 1
  fi
}

# D#2 trigger-function hardening (0720): on the Neon shape the table owner (fx_migrator, not a superuser) fires the triggers
# when an FK cascade deletes account_members rows, so it must hold EXECUTE on both helpers, and the helper must still fire.
# Everything runs in a transaction that is rolled back.
check_guard_definer_owner_cascade() {
  local dbname="$1" out rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" 2>&1 <<'EOSQL'
BEGIN;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN RAISE EXCEPTION 'migration role is a superuser'; END IF;
  IF NOT has_function_privilege(current_user, 'public.runner_revoke_on_member_change_apply(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege(current_user, 'public.model_connections_onboarding_mark_apply(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the table owner has no EXECUTE on a guard helper';
  END IF;
END
$$;
INSERT INTO users (id, email) VALUES ('00000000-0000-4000-8000-0000000000a1', 'own-a1@example.test'), ('00000000-0000-4000-8000-0000000000a2', 'own-a2@example.test'), ('00000000-0000-4000-8000-0000000000a3', 'own-a3@example.test');
INSERT INTO accounts (id, plan) VALUES ('00000000-0000-4000-8000-0000000000b1', 'starter');
INSERT INTO account_members (account_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'owner'),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', 'admin'),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a3', 'member');
INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode)
VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2',
        '{"kty":"OKP","crv":"Ed25519","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}', repeat('a', 43), 'subscription');
UPDATE account_members SET role = 'member' WHERE user_id = '00000000-0000-4000-8000-0000000000a2';
DO $$
BEGIN
  IF (SELECT revoked_reason FROM runners WHERE id = '00000000-0000-4000-8000-0000000000c1') IS DISTINCT FROM 'member_demoted' THEN
    RAISE EXCEPTION 'the runner revoke helper did not fire for the table owner';
  END IF;
END
$$;
DELETE FROM users WHERE id = '00000000-0000-4000-8000-0000000000a3';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_members WHERE user_id = '00000000-0000-4000-8000-0000000000a3') THEN RAISE EXCEPTION 'cascade did not delete the membership'; END IF;
END
$$;
DELETE FROM accounts WHERE id = '00000000-0000-4000-8000-0000000000b1';
ROLLBACK;
EOSQL
  )" || rc=$?
  if [ "$rc" -ne 0 ] || grep -qi "error" <<<"$out"; then
    echo "neon-shape ($dbname): guard helper owner/cascade check failed (exit $rc): $out" >&2
    exit 1
  fi
}

# D#2 SANDBOX-REAPER-1a: the SECURITY DEFINER functions owned by sandbox_reaper (0731). Prints their oids, comma separated, when
# each is one of the four definers pinned to search_path=pg_catalog, public, pg_temp and executable by agent_run_writer and no one
# else, with no grant option; SHAPE_FAIL:<count> when any is not; nothing when the role owns none (the generic owner check then
# rejects anything else).
check_sandbox_reaper_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.proname IN ('sandbox_reap_candidates_terminal', 'sandbox_reap_claim', 'sandbox_reap_done', 'sandbox_reap_unknown_names')
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'agent_run_writer'::regrole)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND (a.grantee <> 'agent_run_writer'::regrole OR a.is_grantable))) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'sandbox_reaper') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'sandbox-reaper-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by sandbox_reaper fail the exception shape (not one of its four definers, a loose search_path, or EXECUTE for anyone but agent_run_writer)"
    return 0
  fi
  echo "$oids"
}

# D#2 SANDBOX-REAPER-1a: role shape of sandbox_reaper. A no-op when the role does not exist. Every problem is named: NOLOGIN and
# unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly the 25 granted
# by 0731 (column SELECTs on four tables, SELECT/INSERT/UPDATE on sandbox_reaps, USAGE on public), owning only its six functions.
check_sandbox_reaper_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.work_item_id SELECT','column agent_runs.status SELECT','column agent_runs.sandbox_name SELECT','column agent_runs.dispatch_repo_id SELECT','column agent_runs.dispatch_pr_number SELECT','column agent_runs.created_at SELECT','column agent_runs.compute_settle_due_at SELECT','column work_items.id SELECT','column work_items.account_id SELECT','column work_items.repo_id SELECT','column work_items.gh_number SELECT','column work_items.stage SELECT','column run_action_requests.account_id SELECT','column run_action_requests.target_id SELECT','column run_action_requests.state SELECT','column spend_reservations.account_id SELECT','column spend_reservations.run_id SELECT','column spend_reservations.state SELECT','column spend_reservations.budget SELECT','table sandbox_reaps SELECT','table sandbox_reaps INSERT','table sandbox_reaps UPDATE','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'sandbox_reaper'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public')
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'sandbox_reaper', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 25 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 25 granted by 0731' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname IN
              ('sandbox_reap_terminal_stages', 'sandbox_reap_ex_state', 'sandbox_reap_candidates_terminal', 'sandbox_reap_claim', 'sandbox_reap_done', 'sandbox_reap_unknown_names')))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'owns an object beyond its six functions' END,
      CASE WHEN has_schema_privilege('sandbox_reaper', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'sandbox_reaper-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): sandbox_reaper role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#221 KS (0739): the one SECURITY DEFINER owned by plan_kind_audit_writer (plan_kind_switch_audit_write(text)), matched by exact name. Prints
# its oid when it is a definer pinned to search_path=pg_catalog, public, pg_temp with EXECUTE for platform_ops (the invoking trigger) and no one else, and no grant
# option; SHAPE_FAIL:<count> when a definer owned by the role is not that; nothing when the role owns none.
check_plan_kind_audit_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.proname = 'plan_kind_switch_audit_write'
        AND p.proargtypes = array_to_string('{text}'::regtype[]::oid[], ' ')::oidvector
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'platform_ops'::regrole)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND (a.grantee <> 'platform_ops'::regrole OR a.is_grantable))) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'plan_kind_audit_writer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'plan-kind-audit-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by plan_kind_audit_writer fail the exception shape (not plan_kind_switch_audit_write(text), a loose search_path, or EXECUTE for anyone but platform_ops)"
    return 0
  fi
  echo "$oids"
}

# D#221 KS (0739): role shape of plan_kind_audit_writer. A no-op when the role does not exist. NOLOGIN and unprivileged, no member but
# the migration role and no live membership for it, a member of no role, privileges exactly INSERT on plan_kind_switch_audit and SELECT of three columns of plan_kind_switches, owning only
# its one function, no CREATE on public.
check_plan_kind_audit_role_shape() {
  local dbname="$1" out rc=0 problems
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'plan_kind_audit_writer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public')
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'plan_kind_audit_writer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 4 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY['table plan_kind_switch_audit INSERT','column plan_kind_switches.kind SELECT','column plan_kind_switches.enabled SELECT','column plan_kind_switches.updated_by SELECT'])) THEN 'privileges are not exactly the 4 granted by 0739' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname = 'plan_kind_switch_audit_write'))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'owns an object beyond plan_kind_switch_audit_write' END,
      CASE WHEN has_schema_privilege('plan_kind_audit_writer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'plan_kind_audit_writer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): plan_kind_audit_writer role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#483 S3-H (0753): the one SECURITY DEFINER owned by proposal_work_item_reader (proposal_work_item_lookup(uuid)), matched by exact name. Prints
# its oid when it is a definer pinned to search_path=pg_catalog, public, pg_temp with EXECUTE for platform_ops (approve_proposal) and no one else, and no grant
# option; SHAPE_FAIL:<count> when a definer owned by the role is not that; nothing when the role owns none.
check_proposal_work_item_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.proname = 'proposal_work_item_lookup'
        AND p.proargtypes = array_to_string('{uuid}'::regtype[]::oid[], ' ')::oidvector
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'platform_ops'::regrole)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND (a.grantee <> 'platform_ops'::regrole OR a.is_grantable))) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'proposal_work_item_reader') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'proposal-work-item-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by proposal_work_item_reader fail the exception shape (not proposal_work_item_lookup(uuid), a loose search_path, or EXECUTE for anyone but platform_ops)"
    return 0
  fi
  echo "$oids"
}

# D#483 S3-H (0753): role shape of proposal_work_item_reader. A no-op when the role does not exist. NOLOGIN and unprivileged, no member but
# the migration role and no live membership for it, a member of no role, privileges exactly SELECT of four columns of work_items, owning only
# its one function, no CREATE on public.
check_proposal_work_item_role_shape() {
  local dbname="$1" out rc=0 problems
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'proposal_work_item_reader'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public')
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'proposal_work_item_reader', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 4 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY['column work_items.id SELECT','column work_items.account_id SELECT','column work_items.repo_id SELECT','column work_items.stage SELECT'])) THEN 'privileges are not exactly the 4 granted by 0753' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid AND NOT (p.pronamespace = 'public'::regnamespace AND p.proname = 'proposal_work_item_lookup'))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'owns an object beyond proposal_work_item_lookup' END,
      CASE WHEN has_schema_privilege('proposal_work_item_reader', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'proposal_work_item_reader-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): proposal_work_item_reader role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#2 PLATFORM-OPS-READ (0742): the SECURITY DEFINER functions owned by sandbox_settle_definer. Prints their oids, comma separated,
# when each is one of the three exact signatures (matched by regprocedure, not by name), pinned to search_path=pg_catalog, public,
# pg_temp, with an ACL that holds agent_run_writer and nobody else but the owner (and platform_ops, for the two listers only),
# with no grant option; SHAPE_FAIL:<count> when any is not; nothing when the role owns none (the generic owner check then rejects
# anything else).
check_sandbox_settle_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid IN ('public.agent_run_sandbox_mark(uuid,uuid,boolean,text,boolean,jsonb,boolean,text)'::regprocedure,
                               'public.compute_settle_list_due(integer)'::regprocedure, 'public.agent_run_list_running(integer,integer)'::regprocedure)
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'agent_run_writer'::regrole)
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable OR (a.grantee <> p.proowner AND a.grantee <> 'agent_run_writer'::regrole
              AND NOT (a.grantee = 'platform_ops'::regrole AND p.oid <> 'public.agent_run_sandbox_mark(uuid,uuid,boolean,text,boolean,jsonb,boolean,text)'::regprocedure)))) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'sandbox_settle_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'sandbox-settle-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by sandbox_settle_definer fail the exception shape (not one of its three exact signatures, a loose search_path, EXECUTE for anyone but agent_run_writer, the owner and (listers only) platform_ops, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#2 PLATFORM-OPS-READ (0742): role shape of sandbox_settle_definer. A no-op when the role does not exist. Every problem is named:
# NOLOGIN and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly
# the 26 granted by 0742 (13 + 6 agent_runs column SELECT/UPDATE, 4 spend_reservations and 2 accounts column SELECT, USAGE on public),
# owning exactly its three functions and nothing else.
check_sandbox_settle_definer_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.role SELECT','column agent_runs.status SELECT','column agent_runs.dispatch_repo_id SELECT','column agent_runs.dispatch_pr_number SELECT','column agent_runs.sandbox_name SELECT','column agent_runs.sandbox_requested_at SELECT','column agent_runs.sandbox_session_ids SELECT','column agent_runs.sandbox_stopped_at SELECT','column agent_runs.sandbox_self_measured SELECT','column agent_runs.compute_settle_due_at SELECT','column agent_runs.compute_settle_retry_at SELECT','column agent_runs.sandbox_requested_at UPDATE','column agent_runs.sandbox_session_ids UPDATE','column agent_runs.sandbox_stopped_at UPDATE','column agent_runs.sandbox_self_measured UPDATE','column agent_runs.compute_settle_due_at UPDATE','column agent_runs.sandbox_name UPDATE','column spend_reservations.account_id SELECT','column spend_reservations.run_id SELECT','column spend_reservations.state SELECT','column spend_reservations.budget SELECT','column accounts.id SELECT','column accounts.deleted_at SELECT','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'sandbox_settle_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'sandbox_settle_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 26 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 26 granted by 0742' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 3
              OR EXISTS (SELECT 1 FROM mine WHERE oid <> ALL (ARRAY['public.agent_run_sandbox_mark(uuid,uuid,boolean,text,boolean,jsonb,boolean,text)'::regprocedure,
                   'public.compute_settle_list_due(integer)'::regprocedure, 'public.agent_run_list_running(integer,integer)'::regprocedure]::oid[]))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its three functions and nothing else' END,
      CASE WHEN has_schema_privilege('sandbox_settle_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'sandbox_settle_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): sandbox_settle_definer role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#7 DP8 halt marker (0750): the one SECURITY DEFINER owned by work_item_halt_definer (work_item_halt_lock(uuid, uuid)), matched
# by exact signature. Prints its oid when it is a definer pinned to search_path=pg_catalog, public, pg_temp whose ACL holds platform_ops
# and the migration role and nobody else but the owner, with no PUBLIC entry and no grant option; SHAPE_FAIL:<count> when a definer owned
# by the role is not that; nothing when the role owns none (the generic owner check then rejects anything else).
check_work_item_halt_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid = 'public.work_item_halt_lock(uuid,uuid)'::regprocedure
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 OR a.is_grantable)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee) ORDER BY pg_get_userbyid(a.grantee))
               FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) = ARRAY['fx_migrator', 'platform_ops']::name[]) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'work_item_halt_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'work-item-halt-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by work_item_halt_definer fail the exception shape (not work_item_halt_lock(uuid, uuid), a loose search_path, EXECUTE for anyone but platform_ops, the owner and the migration role, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#7 DP8 halt marker (0750): role shape of work_item_halt_definer. A no-op when the role does not exist. Every problem is named:
# NOLOGIN and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly
# the 5 granted by 0750 (work_items.id, account_id and halted_at SELECT, halted_at UPDATE, USAGE on public), owning exactly its one
# function and nothing else, no CREATE on public. Its two policies on work_items are pinned too: a read policy and an update policy
# whose WITH CHECK is false, for this role only; and platform_ops has no halt-marker grant or policy on that table.
check_work_item_halt_definer_role_shape() {
  local dbname="$1" out rc=0
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'work_item_halt_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'work_item_halt_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 5 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY['column work_items.id SELECT','column work_items.account_id SELECT','column work_items.halted_at SELECT','column work_items.halted_at UPDATE','schema public USAGE']))
           THEN 'privileges are not exactly the 5 granted by 0750' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 1 OR EXISTS (SELECT 1 FROM mine WHERE oid <> 'public.work_item_halt_lock(uuid,uuid)'::regprocedure)
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its one function and nothing else' END,
      CASE WHEN has_schema_privilege('work_item_halt_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END,
      CASE WHEN (SELECT count(*) FROM pg_policies WHERE tablename = 'work_items' AND roles = ARRAY['work_item_halt_definer']::name[]) <> 2
              OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'work_items' AND roles = ARRAY['work_item_halt_definer']::name[] AND cmd = 'UPDATE' AND with_check = 'false')
           THEN 'its two work_items policies are not a read policy and a WITH CHECK (false) update policy' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'work_items' AND policyname LIKE 'platform_ops_halt_lock%')
              OR has_column_privilege('platform_ops', 'public.work_items', 'halted_at', 'SELECT')
              OR has_column_privilege('platform_ops', 'public.work_items', 'halted_at', 'UPDATE') THEN 'platform_ops holds a halt-marker grant or policy' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'work_item_halt_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  if [ -n "$out" ]; then
    echo "neon-shape ($dbname): work_item_halt_definer role shape wrong: $out" >&2
    exit 1
  fi
}

# D#6 R2b-3 (0754, C21 section 11): the SECURITY DEFINER functions owned by runner_lease_definer. Prints their oids, comma separated,
# when each is one of the six exact signatures (matched by regprocedure, not by name), pinned to search_path=pg_catalog, public,
# pg_temp, with an ACL that holds the one login that calls it (app_user for the throttle, agent_run_writer for the other five) and
# nobody else but the owner, with no grant option; SHAPE_FAIL:<count> when any is not; nothing when the role owns none (the generic
# owner check then rejects anything else).
check_runner_lease_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid IN ('public.agent_run_runner_claim(uuid,uuid,uuid,timestamptz,integer)'::regprocedure, 'public.agent_run_runner_lease(uuid,uuid,uuid,integer,timestamptz,integer,bigint)'::regprocedure, 'public.runner_claim_throttle(integer)'::regprocedure, 'public.agent_run_list_running_runner_runs(integer,bigint)'::regprocedure, 'public.agent_run_list_jobless_runner_runs(integer)'::regprocedure, 'public.runner_follow_up_run(uuid)'::regprocedure)
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0)
            = CASE WHEN p.proname = 'runner_claim_throttle' THEN ARRAY['app_user'] ELSE ARRAY['agent_run_writer'] END
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'runner_lease_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'runner-lease-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by runner_lease_definer fail the exception shape (not one of its six exact signatures, a loose search_path, EXECUTE for anyone but the one login that calls it and the owner, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#6 R2b-3 (0754, C21 section 11): role shape of runner_lease_definer. A no-op when the role does not exist. Every problem is named:
# NOLOGIN and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly
# the 48 granted by 0754 (column SELECT and UPDATE on agent_runs, runners, runner_claim_stamps (and INSERT there), run_events and accounts,
# USAGE on public; nothing table-wide), owning exactly its six functions and nothing else (the table runner_claim_stamps is the
# migration role's).
check_runner_lease_definer_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.work_item_id SELECT','column agent_runs.parent_run_id SELECT','column agent_runs.role SELECT','column agent_runs.runtime SELECT','column agent_runs.status SELECT','column agent_runs.head_sha SELECT','column agent_runs.execution_mode SELECT','column agent_runs.dispatch_repo_id SELECT','column agent_runs.dispatch_pr_number SELECT','column agent_runs.spec_version_id SELECT','column agent_runs.resolved_exposure SELECT','column agent_runs.exposure_digest SELECT','column agent_runs.initiated_by SELECT','column agent_runs.approved_by SELECT','column agent_runs.runner_id SELECT','column agent_runs.lease_generation SELECT','column agent_runs.lease_expires_at SELECT','column agent_runs.claimable_after SELECT','column agent_runs.started_at SELECT','column agent_runs.created_at SELECT','column agent_runs.job_signed SELECT','column agent_runs.runner_id UPDATE','column agent_runs.lease_generation UPDATE','column agent_runs.lease_expires_at UPDATE','column agent_runs.updated_at UPDATE','column agent_runs.claimable_after UPDATE','column agent_runs.approved_by UPDATE','column runners.id SELECT','column runners.account_id SELECT','column runners.revoked_at SELECT','column runners.last_seen_at UPDATE','column runner_claim_stamps.runner_id SELECT','column runner_claim_stamps.account_id SELECT','column runner_claim_stamps.last_claim_at SELECT','column runner_claim_stamps.runner_id INSERT','column runner_claim_stamps.account_id INSERT','column runner_claim_stamps.last_claim_at INSERT','column runner_claim_stamps.last_claim_at UPDATE','column run_events.account_id SELECT','column run_events.run_id SELECT','column run_events.seq SELECT','column run_events.kind SELECT','column run_events.payload SELECT','column accounts.id SELECT','column accounts.deleted_at SELECT','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'runner_lease_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'runner_lease_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 48 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 48 granted by 0754' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 6
              OR EXISTS (SELECT 1 FROM mine WHERE oid <> ALL (ARRAY['public.agent_run_runner_claim(uuid,uuid,uuid,timestamptz,integer)'::regprocedure, 'public.agent_run_runner_lease(uuid,uuid,uuid,integer,timestamptz,integer,bigint)'::regprocedure, 'public.runner_claim_throttle(integer)'::regprocedure, 'public.agent_run_list_running_runner_runs(integer,bigint)'::regprocedure, 'public.agent_run_list_jobless_runner_runs(integer)'::regprocedure, 'public.runner_follow_up_run(uuid)'::regprocedure]::oid[]))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its six functions and nothing else' END,
      CASE WHEN has_schema_privilege('runner_lease_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'runner_lease_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): runner_lease_definer role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#6 R2b-3 part (ii) (0757, C21 section 11): the SECURITY DEFINER functions owned by runner_approval_definer. Prints their oids, comma
# separated, when each is one of the two exact signatures (matched by regprocedure, not by name), pinned to search_path=pg_catalog,
# public, pg_temp, with an ACL that holds app_user and nobody else but the owner (no PUBLIC, no platform_ops), with no grant option;
# SHAPE_FAIL:<count> when any is not; nothing when the role owns none (the generic owner check then rejects anything else).
check_runner_approval_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid IN ('public.agent_run_approve(uuid)'::regprocedure, 'public.repo_execution_mode_audit(uuid,text,text,boolean)'::regprocedure)
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0) = ARRAY['app_user']
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'runner_approval_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'runner-approval-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by runner_approval_definer fail the exception shape (not one of its two exact signatures, a loose search_path, EXECUTE for anyone but app_user and the owner, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#6 R2b-3 part (ii) (0757, C21 section 11): role shape of runner_approval_definer. A no-op when the role does not exist. Every problem
# is named: NOLOGIN and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges
# exactly the 26 granted by 0757 (column SELECT and UPDATE on agent_runs, column SELECT on runners, account_members, repos and accounts,
# column INSERT on audit_log, USAGE on public; nothing table-wide), owning exactly its two functions and nothing else.
check_runner_approval_definer_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.status SELECT','column agent_runs.runtime SELECT','column agent_runs.execution_mode SELECT','column agent_runs.approved_by SELECT','column agent_runs.approved_by UPDATE','column agent_runs.updated_at UPDATE','column runners.id SELECT','column runners.account_id SELECT','column runners.registered_by SELECT','column runners.credential_mode SELECT','column runners.revoked_at SELECT','column account_members.account_id SELECT','column account_members.user_id SELECT','column account_members.role SELECT','column repos.id SELECT','column repos.account_id SELECT','column audit_log.account_id INSERT','column audit_log.actor INSERT','column audit_log.action INSERT','column audit_log.payload INSERT','column audit_log.created_at INSERT','column accounts.id SELECT','column accounts.deleted_at SELECT','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'runner_approval_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'runner_approval_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 26 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 26 granted by 0757' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 2
              OR EXISTS (SELECT 1 FROM mine WHERE oid <> ALL (ARRAY['public.agent_run_approve(uuid)'::regprocedure, 'public.repo_execution_mode_audit(uuid,text,text,boolean)'::regprocedure]::oid[]))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its two functions and nothing else' END,
      CASE WHEN has_schema_privilege('runner_approval_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'runner_approval_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): runner_approval_definer role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#6 R2b (0759, C24 section 2): the SECURITY DEFINER functions owned by runner_mode_switch_definer. Prints their oids, comma
# separated, when each is one of the two exact signatures (matched by regprocedure, not by name), pinned to search_path=pg_catalog,
# public, pg_temp, with an ACL that holds app_user and nobody else but the owner (no PUBLIC, no platform_ops), with no grant option;
# SHAPE_FAIL:<count> when any is not; nothing when the role owns none (the generic owner check then rejects anything else).
check_runner_mode_switch_definer_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid IN ('public.repo_cancel_pending_runner_runs(uuid)'::regprocedure, 'public.repo_execution_mode_switch_audit(uuid,text,text,boolean,integer)'::regprocedure)
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0) = ARRAY['app_user']
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'runner_mode_switch_definer') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'runner-mode-switch-definer-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by runner_mode_switch_definer fail the exception shape (not one of its two exact signatures, a loose search_path, EXECUTE for anyone but app_user and the owner, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#6 R2b (0759, C24 section 2): role shape of runner_mode_switch_definer. A no-op when the role does not exist. Every problem
# is named: NOLOGIN and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges
# exactly the 21 granted by 0759 (column SELECT and the updated_at UPDATE on agent_runs, column SELECT on account_members, repos and accounts,
# column INSERT on audit_log, USAGE on public; nothing table-wide), owning exactly its two functions and nothing else.
check_runner_mode_switch_definer_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.status SELECT','column agent_runs.runtime SELECT','column agent_runs.execution_mode SELECT','column agent_runs.dispatch_repo_id SELECT','column agent_runs.updated_at UPDATE','column account_members.account_id SELECT','column account_members.user_id SELECT','column account_members.role SELECT','column repos.id SELECT','column repos.account_id SELECT','column repos.execution_mode SELECT','column accounts.id SELECT','column accounts.deleted_at SELECT','column audit_log.account_id INSERT','column audit_log.actor INSERT','column audit_log.action INSERT','column audit_log.payload INSERT','column audit_log.created_at INSERT','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'runner_mode_switch_definer'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'runner_mode_switch_definer', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 21 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 21 granted by 0759' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 2
              OR EXISTS (SELECT 1 FROM mine WHERE oid <> ALL (ARRAY['public.repo_cancel_pending_runner_runs(uuid)'::regprocedure, 'public.repo_execution_mode_switch_audit(uuid,text,text,boolean,integer)'::regprocedure]::oid[]))
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its two functions and nothing else' END,
      CASE WHEN has_schema_privilege('runner_mode_switch_definer', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'runner_mode_switch_definer-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): runner_mode_switch_definer role shape wrong: $problems" >&2
    exit 1
  fi
}

# D#6 R2b-3 part (ii) (0757): the one SECURITY DEFINER function owned by runner_notice_lister, the cross-tenant list of runner runs that
# still owe a notice. Prints its oid when it is exactly 'agent_run_list_runner_runs_owing_notice(integer,bigint,bigint)' (matched by regprocedure),
# pinned to search_path=pg_catalog, public, pg_temp, with an ACL that holds agent_run_writer and nobody else but the owner (no PUBLIC, no
# platform_ops, no app_user), with no grant option; SHAPE_FAIL:<count> when any function the role owns is not; nothing when it owns none.
check_runner_notice_lister_exception_shape() {
  local dbname="$1" row rc=0 oids bad
  row="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -F'|' -c "
    SELECT coalesce(string_agg(oid::text, ', ') FILTER (WHERE ok), ''), count(*) FILTER (WHERE NOT ok) FROM (
      SELECT p.oid, (p.oid = 'public.agent_run_list_runner_runs_owing_notice(integer,bigint,bigint)'::regprocedure
        AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'] AND p.proacl IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable)
        AND (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND a.grantee <> 0) = ARRAY['agent_run_writer']
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'runner_notice_lister') x;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(awk -F'|' '{print NF; exit}' <<<"$row")" != "2" ]; then
    echo "SHAPE_FAIL:psql failed for check 'runner-notice-lister-function-shape' on $dbname (exit $rc): $row"
    return 0
  fi
  IFS='|' read -r oids bad <<<"$row"
  if [ "$bad" != "0" ]; then
    echo "SHAPE_FAIL:$bad SECURITY DEFINER function(s) owned by runner_notice_lister fail the exception shape (not its one exact signature, a loose search_path, EXECUTE for anyone but agent_run_writer and the owner, or a grant option)"
    return 0
  fi
  echo "$oids"
}

# D#6 R2b-3 part (ii) (0757): role shape of runner_notice_lister. A no-op when the role does not exist. Every problem is named: NOLOGIN
# and unprivileged, no member but the migration role and no live membership for it, a member of no role, privileges exactly the 10
# granted by 0757 (column SELECT on agent_runs and run_events, USAGE on public; nothing table-wide), owning exactly its one function and
# nothing else.
check_runner_notice_lister_role_shape() {
  local dbname="$1" out rc=0 problems
  local expected="'column agent_runs.id SELECT','column agent_runs.account_id SELECT','column agent_runs.status SELECT','column agent_runs.runtime SELECT','column agent_runs.execution_mode SELECT','column agent_runs.created_at SELECT','column run_events.account_id SELECT','column run_events.run_id SELECT','column run_events.kind SELECT','schema public USAGE'"
  out="$("${PSQL[@]}" -U fx_migrator -d "$dbname" -tA -c "
    WITH r AS (SELECT * FROM pg_roles WHERE rolname = 'runner_notice_lister'),
    held AS (
      SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
      UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'),
    mine AS (SELECT p.oid FROM pg_proc p, r WHERE p.proowner = r.oid)
    SELECT concat_ws('; ',
      CASE WHEN r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN 'privileged attribute' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid AND member <> 'fx_migrator'::regrole) THEN 'has a member besides the migration role' END,
      CASE WHEN coalesce((SELECT bool_or(inherit_option OR set_option) FROM pg_auth_members WHERE roleid = r.oid AND member = 'fx_migrator'::regrole), false)
                OR pg_has_role('fx_migrator', 'runner_notice_lister', 'USAGE') THEN 'fx_migrator holds a live membership' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) THEN 'is a member of another role' END,
      CASE WHEN (SELECT count(*) FROM held) <> 10 OR EXISTS (SELECT 1 FROM held WHERE x <> ALL (ARRAY[$expected])) THEN 'privileges are not exactly the 10 granted by 0757' END,
      CASE WHEN (SELECT count(*) FROM mine) <> 1
              OR EXISTS (SELECT 1 FROM mine WHERE oid <> 'public.agent_run_list_runner_runs_owing_notice(integer,bigint,bigint)'::regprocedure::oid)
              OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
              OR EXISTS (SELECT 1 FROM pg_type t WHERE t.typowner = r.oid) THEN 'does not own exactly its one function and nothing else' END,
      CASE WHEN has_schema_privilege('runner_notice_lister', 'public', 'CREATE') THEN 'still has CREATE on public' END)
    FROM r;" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "neon-shape ($dbname): psql failed for check 'runner_notice_lister-shape' (exit $rc): $out" >&2
    exit 1
  fi
  problems="$out"
  if [ -n "$problems" ]; then
    echo "neon-shape ($dbname): runner_notice_lister role shape wrong: $problems" >&2
    exit 1
  fi
}

# criterion 8: every SECURITY DEFINER function in public is owned by
# platform_ops, except the named exemptions above -- the DS-0a eraser
# (discussion_eraser) and the three D#7 receipt_writer definers
# (decision_receipt_write, decision_receipt_write_class1, decision_ask_raise), each admitted
# only when its own shape check passes; fx_migrator does not INHERIT any
# runtime role, including discussion_eraser and receipt_writer.
EXEMPT_RESULT="$(check_eraser_exception_shape fx_neon)"
if [[ "$EXEMPT_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${EXEMPT_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
EXEMPT_FILTER="${EXEMPT_RESULT:-0}"
if ! [[ "$EXEMPT_FILTER" =~ ^[0-9]+$ ]]; then
  echo "neon-shape: internal error -- exempt function oid was not numeric: $EXEMPT_RESULT" >&2
  exit 1
fi
RECEIPT_RESULT="$(check_receipt_writer_exception_shape fx_neon decision_receipt_write text,text,text,text,integer,jsonb,uuid,uuid,integer)"
RECEIPT1_RESULT="$(check_receipt_writer_exception_shape fx_neon decision_receipt_write_class1 text,text,text,integer,jsonb,uuid,uuid,integer)"
ASK_RESULT="$(check_receipt_writer_exception_shape fx_neon decision_ask_raise text,text,uuid,uuid,jsonb,text,text,jsonb,integer,text)"
for RESULT in "$RECEIPT_RESULT" "$RECEIPT1_RESULT" "$ASK_RESULT"; do
  if [[ "$RESULT" == SHAPE_FAIL:* ]]; then
    echo "neon-shape: ${RESULT#SHAPE_FAIL:}" >&2
    exit 1
  fi
  if [ -n "$RESULT" ] && ! [[ "$RESULT" =~ ^[0-9]+$ ]]; then
    echo "neon-shape: internal error -- receipt exempt function oid was not numeric: $RESULT" >&2
    exit 1
  fi
done
METERING_RESULT="$(check_metering_reporter_exception_shape fx_neon)"
if [[ "$METERING_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${METERING_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$METERING_RESULT" ] && ! [[ "$METERING_RESULT" =~ ^[0-9]+$ ]]; then
  echo "neon-shape: internal error -- metering exempt function oid was not numeric: $METERING_RESULT" >&2
  exit 1
fi
ERROR_EVENT_RESULT="$(check_error_event_writer_exception_shape fx_neon)"
if [[ "$ERROR_EVENT_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${ERROR_EVENT_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$ERROR_EVENT_RESULT" ] && ! [[ "$ERROR_EVENT_RESULT" =~ ^[0-9]+$ ]]; then
  echo "neon-shape: internal error -- error_event exempt function oid was not numeric: $ERROR_EVENT_RESULT" >&2
  exit 1
fi
GUARD_DEFINER_RESULT="$(check_guard_definer_exception_shape fx_neon)"
if [[ "$GUARD_DEFINER_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${GUARD_DEFINER_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$GUARD_DEFINER_RESULT" ] && ! [[ "$GUARD_DEFINER_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- guard_definer exempt function oids were not numeric: $GUARD_DEFINER_RESULT" >&2
  exit 1
fi
SANDBOX_REAPER_RESULT="$(check_sandbox_reaper_exception_shape fx_neon)"
if [[ "$SANDBOX_REAPER_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${SANDBOX_REAPER_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$SANDBOX_REAPER_RESULT" ] && ! [[ "$SANDBOX_REAPER_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- sandbox_reaper exempt function oids were not numeric: $SANDBOX_REAPER_RESULT" >&2
  exit 1
fi
PLAN_KIND_AUDIT_RESULT="$(check_plan_kind_audit_exception_shape fx_neon)"
if [[ "$PLAN_KIND_AUDIT_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${PLAN_KIND_AUDIT_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$PLAN_KIND_AUDIT_RESULT" ] && ! [[ "$PLAN_KIND_AUDIT_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- plan_kind_audit_writer exempt function oid was not numeric: $PLAN_KIND_AUDIT_RESULT" >&2
  exit 1
fi
PROPOSAL_WI_RESULT="$(check_proposal_work_item_exception_shape fx_neon)"
if [[ "$PROPOSAL_WI_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${PROPOSAL_WI_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$PROPOSAL_WI_RESULT" ] && ! [[ "$PROPOSAL_WI_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- proposal_work_item_reader exempt function oid was not numeric: $PROPOSAL_WI_RESULT" >&2
  exit 1
fi
SANDBOX_SETTLE_RESULT="$(check_sandbox_settle_definer_exception_shape fx_neon)"
if [[ "$SANDBOX_SETTLE_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${SANDBOX_SETTLE_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$SANDBOX_SETTLE_RESULT" ] && ! [[ "$SANDBOX_SETTLE_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- sandbox_settle_definer exempt function oids were not numeric: $SANDBOX_SETTLE_RESULT" >&2
  exit 1
fi
WORK_ITEM_HALT_RESULT="$(check_work_item_halt_definer_exception_shape fx_neon)"
if [[ "$WORK_ITEM_HALT_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${WORK_ITEM_HALT_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$WORK_ITEM_HALT_RESULT" ] && ! [[ "$WORK_ITEM_HALT_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- work_item_halt_definer exempt function oid was not numeric: $WORK_ITEM_HALT_RESULT" >&2
  exit 1
fi
RUNNER_LEASE_RESULT="$(check_runner_lease_definer_exception_shape fx_neon)"
if [[ "$RUNNER_LEASE_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${RUNNER_LEASE_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$RUNNER_LEASE_RESULT" ] && ! [[ "$RUNNER_LEASE_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- runner_lease_definer exempt function oids were not numeric: $RUNNER_LEASE_RESULT" >&2
  exit 1
fi
RUNNER_APPROVAL_RESULT="$(check_runner_approval_definer_exception_shape fx_neon)"
if [[ "$RUNNER_APPROVAL_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${RUNNER_APPROVAL_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$RUNNER_APPROVAL_RESULT" ] && ! [[ "$RUNNER_APPROVAL_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- runner_approval_definer exempt function oids were not numeric: $RUNNER_APPROVAL_RESULT" >&2
  exit 1
fi
RUNNER_MODE_SWITCH_RESULT="$(check_runner_mode_switch_definer_exception_shape fx_neon)"
if [[ "$RUNNER_MODE_SWITCH_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${RUNNER_MODE_SWITCH_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$RUNNER_MODE_SWITCH_RESULT" ] && ! [[ "$RUNNER_MODE_SWITCH_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- runner_mode_switch_definer exempt function oids were not numeric: $RUNNER_MODE_SWITCH_RESULT" >&2
  exit 1
fi
RUNNER_NOTICE_RESULT="$(check_runner_notice_lister_exception_shape fx_neon)"
if [[ "$RUNNER_NOTICE_RESULT" == SHAPE_FAIL:* ]]; then
  echo "neon-shape: ${RUNNER_NOTICE_RESULT#SHAPE_FAIL:}" >&2
  exit 1
fi
if [ -n "$RUNNER_NOTICE_RESULT" ] && ! [[ "$RUNNER_NOTICE_RESULT" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
  echo "neon-shape: internal error -- runner_notice_lister exempt function oid was not numeric: $RUNNER_NOTICE_RESULT" >&2
  exit 1
fi
RECEIPT_FILTER="${RECEIPT_RESULT:-0}, ${RECEIPT1_RESULT:-0}, ${ASK_RESULT:-0}, ${METERING_RESULT:-0}, ${ERROR_EVENT_RESULT:-0}, ${GUARD_DEFINER_RESULT:-0}, ${SANDBOX_REAPER_RESULT:-0}, ${PLAN_KIND_AUDIT_RESULT:-0}, ${SANDBOX_SETTLE_RESULT:-0}, ${WORK_ITEM_HALT_RESULT:-0}, ${PROPOSAL_WI_RESULT:-0}, ${RUNNER_LEASE_RESULT:-0}, ${RUNNER_APPROVAL_RESULT:-0}, ${RUNNER_NOTICE_RESULT:-0}, ${RUNNER_MODE_SWITCH_RESULT:-0}"
BAD_DEFINERS="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "
  SELECT string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') owner=' || pg_get_userbyid(p.proowner), ', ')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND n.nspname = 'public'
    AND pg_get_userbyid(p.proowner) <> 'platform_ops'
    AND p.oid NOT IN ($EXEMPT_FILTER, $RECEIPT_FILTER);")"
if [ -n "$BAD_DEFINERS" ]; then
  echo "neon-shape: SECURITY DEFINER function(s) in public not owned by platform_ops: $BAD_DEFINERS" >&2
  exit 1
fi
check_eraser_role_shape fx_neon
check_receipt_writer_role_shape fx_neon
check_metering_reporter_role_shape fx_neon
check_error_event_writer_role_shape fx_neon
check_guard_definer_role_shape fx_neon
check_guard_definer_owner_cascade fx_neon
check_sandbox_reaper_role_shape fx_neon
check_plan_kind_audit_role_shape fx_neon
check_sandbox_settle_definer_role_shape fx_neon
check_work_item_halt_definer_role_shape fx_neon
check_proposal_work_item_role_shape fx_neon
check_runner_lease_definer_role_shape fx_neon
check_runner_approval_definer_role_shape fx_neon
check_runner_notice_lister_role_shape fx_neon
check_runner_mode_switch_definer_role_shape fx_neon
OPS_USAGE="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "SELECT pg_has_role('fx_migrator','platform_ops','USAGE');")"
APP_USAGE="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "SELECT pg_has_role('fx_migrator','app_user','USAGE');")"
PARTNER_USAGE="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "SELECT pg_has_role('fx_migrator','partner_user','USAGE');")"
if [ "$OPS_USAGE" != "f" ] || [ "$APP_USAGE" != "f" ] || [ "$PARTNER_USAGE" != "f" ]; then
  echo "neon-shape: fx_migrator inherits a runtime role's privileges (platform_ops=$OPS_USAGE app_user=$APP_USAGE partner_user=$PARTNER_USAGE)" >&2
  exit 1
fi

# criterion 9: TEMP is really revoked (not just a no-op WARNING).
APP_TEMP="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "SELECT has_database_privilege('app_user','fx_neon','TEMP');")"
PARTNER_TEMP="$("${PSQL[@]}" -U fx_migrator -d fx_neon -tA -c "SELECT has_database_privilege('partner_user','fx_neon','TEMP');")"
if [ "$APP_TEMP" != "f" ] || [ "$PARTNER_TEMP" != "f" ]; then
  echo "neon-shape: TEMP privilege still held (app_user=$APP_TEMP partner_user=$PARTNER_TEMP)" >&2
  exit 1
fi

# criterion 5a: a role that drifted back to CREATEDB (set by the bootstrap
# superuser, simulating an earlier migration on another database on this
# same cluster -- roles are cluster-wide) must abort the migration on a
# brand new database, and schema_migrations must NOT record 0001 as
# applied. Exercised through the real runMigrations path so the
# bookkeeping half of the criterion is actually checked, not assumed.
echo "==> criterion 5a: a drifted app_user (CREATEDB) must abort the migration"
"${PSQL[@]}" -U postgres -d postgres -c "ALTER ROLE app_user CREATEDB;"
"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_neon_bad_role OWNER fx_migrator;"
BAD_ROLE_URL="postgres://fx_migrator@127.0.0.1:${PG_PORT}/fx_neon_bad_role?host=${PG_TMP_DIR}"
BAD_ROLE_OUT="$("${MIGRATE_RUNNER[@]}" "$BAD_ROLE_URL" "$MIGRATIONS_DIR" 2>&1)" && {
  echo "neon-shape: expected the drifted-app_user migration to fail -- it succeeded" >&2
  exit 1
}
"${PSQL[@]}" -U postgres -d postgres -c "ALTER ROLE app_user NOCREATEDB;" >/dev/null
if ! grep -qi "app_user" <<<"$BAD_ROLE_OUT" || ! grep -qi "createdb" <<<"$BAD_ROLE_OUT"; then
  echo "neon-shape: drifted-role failure message did not name app_user/createdb: $BAD_ROLE_OUT" >&2
  exit 1
fi
BAD_ROLE_RECORDED="$("${PSQL[@]}" -U fx_migrator -d fx_neon_bad_role -tA -c \
  "SELECT count(*) FROM schema_migrations WHERE filename = '0001_core.sql';" 2>/dev/null || echo 0)"
if [ "$BAD_ROLE_RECORDED" != "0" ]; then
  echo "neon-shape: 0001_core.sql was recorded as applied on fx_neon_bad_role despite the failure" >&2
  exit 1
fi

# criterion 5b: a migration role that does NOT own the database must be
# rejected. migrate.ts's own bootstrap step (CREATE TABLE IF NOT EXISTS
# schema_migrations, out of scope to edit here) needs CREATE on schema
# public unconditionally -- a non-owner lacks that too, so going through
# the full runMigrations path fails first with Postgres's own generic
# "permission denied for schema public", never reaching 0001's new
# ownership assertion. This runs 0001_core.sql directly instead (no
# bootstrap step in the way), to exercise that assertion specifically --
# see the PR description for why.
echo "==> criterion 5b: a migration role that doesn't own the database must be rejected"
"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_neon_notowned;"
"${PSQL[@]}" -U postgres -d postgres -c "GRANT CONNECT ON DATABASE fx_neon_notowned TO fx_migrator;"
NOTOWNED_OUT="$(psql -h "$PG_TMP_DIR" -p "$PG_PORT" -U fx_migrator -d fx_neon_notowned -v ON_ERROR_STOP=1 -f "$MIGRATIONS_DIR/0001_core.sql" 2>&1)" && {
  echo "neon-shape: expected the non-owner migration to fail -- it succeeded" >&2
  exit 1
}
if ! grep -qi "must own the database" <<<"$NOTOWNED_OUT"; then
  echo "neon-shape: non-owner failure message did not contain 'must own the database': $NOTOWNED_OUT" >&2
  exit 1
fi

# D#81 fix round (security review MUST-FIX): the UPGRADE path, not just
# the fresh-chain path above. On a database that already has SOME of the
# chain applied, migrate.ts applies whatever isn't yet recorded in
# schema_migrations, in filename order -- so a real Neon database's
# APPLIED order can differ from a fresh chain's, depending on when each
# migration file actually merged relative to when that database was first
# provisioned. This is exactly the shape PR #89's own security review
# caught for 0011_audit_write_role_settings_actions.sql: on a database
# that already had 0200_partners.sql applied (INHERIT FALSE by then),
# 0011's un-bracketed CREATE OR REPLACE FUNCTION audit_write failed with
# "must be owner of function audit_write" -- because on a FRESH chain
# 0011 sorts before 0200 and runs inside the still-open INHERIT TRUE
# window, but an upgrade delivers it after that window already closed.
#
# HISTORICAL_LATE_MIGRATIONS below are the ones that landed in this repo's
# history AFTER 0200_partners.sql was already established and applied
# elsewhere -- 0010 (H22 #88) and 0011 (PR #89) -- plus this fix round's
# own renamed 0601 (was 0012 -- D#94 R1 migration-order rule). Each is now
# bracketed for exactly this (see their own file comments and
# docs/ops/hosted-postgres.md's per-file bracket rule); this proves it on
# the Neon-shaped role, not just superuser (every vitest test in
# packages/db/test runs migrations as the ephemeral cluster's superuser,
# which bypasses every GRANT/REVOKE/INHERIT check here entirely -- this
# script is the only place that doesn't).
#
# D#81 fix round 3 (code re-review MUST-FIX): 0005 and 0008 are ALSO
# late-landing in this sense, despite sorting before 0200 by filename --
# filename order is not applied order (see the header above and each
# file's own comment). 0008's fresh CREATE FUNCTION + OWNER TO already
# self-brackets CREATE on schema public correctly (no INHERIT needed
# there -- see its own file comment), so it was already safe under this
# upgrade path; adding it here proves that rather than assuming it. 0005's
# CREATE OR REPLACE FUNCTION has_open_invitation did NOT self-bracket
# INHERIT before this fix round -- reproduced here: without 0005's fix,
# this batch fails with "must be owner of function has_open_invitation"
# (42501), the same shape 0011's own late-arrival bug took before it was
# bracketed.
#
# HISTORICAL_LATE_MIGRATIONS is held back for TIMING reasons -- when each
# file landed relative to 0200 -- and can't be derived from the file
# contents. 0005/0008/0010/0011/0601 stay a literal list.
#
# D#97 C1: any migration that touches audit_write/audit_write_system also
# has to be held back, for a DIFFERENT reason -- 0008 and 0011 already do
# (hence they're in HISTORICAL_LATE_MIGRATIONS above), but the SAME
# CREATE-OR-REPLACE-before-CREATE ordering bug (see
# audit-log-append-only.test.ts's own comment, same predicate, D#97 C1)
# hits any later migration that also names either function as a FUNCTION.
# LATE_MIGRATIONS is the sorted, de-duplicated union of the historical list
# and that DERIVED set, using the same match rule as the TS predicate
# (grep has no lookahead, so the trailing word-boundary is spelled out as
# a character class instead):
#
#   after stripping "--" line comments, matches, case-insensitively:
#   FUNCTION[[:space:]]+("?public"?[[:space:]]*\.[[:space:]]*)?"?audit_write(_system)?"?([^A-Za-z0-9_]|$)
#
# This does not strip "/* */" block comments and does not look inside
# string literals -- a "--" inside a quoted string is treated as a comment
# start.
#
# D#97 fix round 1 (CWE-697): without `-z`, `grep -E` matches one line at
# a time, so `[[:space:]]+` in the pattern above -- which as a character
# class DOES include a literal newline -- could never actually cross one,
# because grep never hands it a buffer spanning two lines to match
# against in the first place. That made this predicate disagree with the
# TS one (which uses `\s+` against the whole file text) on a statement
# split across lines, e.g. `CREATE OR REPLACE FUNCTION\n  audit_write(`:
# the TS side matched, this one missed it. `-z` makes grep treat its
# whole input (up to a NUL byte, none of which appears here) as a single
# record, so the match can span the embedded newlines exactly like the TS
# version's does.
# D#2 (0721): 0721 changes the owner of functions that 0001, 0005 and 0200 create or replace (current_member_*, has_open_invitation,
# the partner helpers). It is held back so the upgrade path applies it AFTER 0005, as every real database has it: a CREATE OR
# REPLACE of an already guard_definer-owned has_open_invitation in 0005 would otherwise fail for the migration role.
HISTORICAL_LATE_MIGRATIONS=(0005_account_members_role_gate.sql 0008_audit_log_append_only.sql 0010_model_routing.sql 0011_audit_write_role_settings_actions.sql 0601_pin_model_connections_guard_write_search_path.sql 0721_membership_helpers_not_owned_by_platform_ops.sql)

AUDIT_WRITE_FUNCTION_PATTERN='FUNCTION[[:space:]]+("?public"?[[:space:]]*\.[[:space:]]*)?"?audit_write(_system)?"?([^A-Za-z0-9_]|$)'

is_audit_write_migration() {
  # $1: path to a migration file. Strip comments into a variable FIRST,
  # then grep a here-string -- never `sed ... "$f" | grep -q ...`: under
  # `set -o pipefail`, grep -q can exit (and SIGPIPE the sed writer) before
  # sed finishes, turning a real match into a false miss (D#97 C1).
  # `-z` treats the whole input as one record instead of matching
  # line-by-line, so a match can span a newline the same way the TS
  # predicate's `\s+` already does (D#97 fix round 1, CWE-697).
  local stripped
  stripped="$(sed 's/--.*$//' "$1")"
  grep -qizE "$AUDIT_WRITE_FUNCTION_PATTERN" <<<"$stripped"
}

echo "==> self-test: is_audit_write_migration matches a real CREATE, rejects a comment-only mention"
PREDICATE_SELF_TEST_DIR="$PG_TMP_DIR/predicate_self_test"
mkdir -p "$PREDICATE_SELF_TEST_DIR"
cat >"$PREDICATE_SELF_TEST_DIR/match.sql" <<'EOF'
CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid AS $$
BEGIN
END;
$$ LANGUAGE plpgsql;
EOF
cat >"$PREDICATE_SELF_TEST_DIR/nomatch.sql" <<'EOF'
-- audit_write_system is mentioned here only in a comment
SELECT 1;
EOF
# D#97 fix round 1 (CWE-697): FUNCTION and the function name on separate
# lines -- the exact shape a line-based `grep -E` (no `-z`) misses.
cat >"$PREDICATE_SELF_TEST_DIR/splitline.sql" <<'EOF'
CREATE OR REPLACE FUNCTION
    audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid AS $$
BEGIN
END;
$$ LANGUAGE plpgsql;
EOF
if ! is_audit_write_migration "$PREDICATE_SELF_TEST_DIR/match.sql"; then
  echo "neon-shape: self-test FAILED -- predicate did not match a real CREATE OR REPLACE FUNCTION audit_write fixture" >&2
  exit 1
fi
if is_audit_write_migration "$PREDICATE_SELF_TEST_DIR/nomatch.sql"; then
  echo "neon-shape: self-test FAILED -- predicate matched a comment-only audit_write_system fixture" >&2
  exit 1
fi
if ! is_audit_write_migration "$PREDICATE_SELF_TEST_DIR/splitline.sql"; then
  echo "neon-shape: self-test FAILED -- predicate did not match FUNCTION and audit_write split across two lines" >&2
  exit 1
fi

DERIVED_AUDIT_WRITE_MIGRATIONS=()
for f in "$MIGRATIONS_DIR"/*.sql; do
  if is_audit_write_migration "$f"; then
    DERIVED_AUDIT_WRITE_MIGRATIONS+=("$(basename "$f")")
  fi
done

HAS_0008=false
HAS_0011=false
for f in "${DERIVED_AUDIT_WRITE_MIGRATIONS[@]}"; do
  [ "$f" = "0008_audit_log_append_only.sql" ] && HAS_0008=true
  [ "$f" = "0011_audit_write_role_settings_actions.sql" ] && HAS_0011=true
done
if [ "$HAS_0008" != true ] || [ "$HAS_0011" != true ]; then
  echo "neon-shape: derived audit_write migration set does not contain both 0008 and 0011: ${DERIVED_AUDIT_WRITE_MIGRATIONS[*]}" >&2
  exit 1
fi

mapfile -t LATE_MIGRATIONS < <(printf '%s\n' "${HISTORICAL_LATE_MIGRATIONS[@]}" "${DERIVED_AUDIT_WRITE_MIGRATIONS[@]}" | sort -u)

echo "==> upgrade path: apply everything except the late-landing migrations, then apply those one at a time"
UPGRADE_MIGRATIONS_DIR="$PG_TMP_DIR/upgrade_migrations"
mkdir -p "$UPGRADE_MIGRATIONS_DIR"
for f in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$f")"
  skip=false
  for late in "${LATE_MIGRATIONS[@]}"; do
    [ "$base" = "$late" ] && skip=true && break
  done
  [ "$skip" = true ] || cp "$f" "$UPGRADE_MIGRATIONS_DIR/$base"
done
MAIN_CHAIN_FILES="$(ls "$UPGRADE_MIGRATIONS_DIR"/*.sql | xargs -n1 basename | sort)"

"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_upgrade OWNER fx_migrator;"
FX_UPGRADE_URL="postgres://fx_migrator@127.0.0.1:${PG_PORT}/fx_upgrade?host=${PG_TMP_DIR}"

echo "==> upgrade path: migrating fx_upgrade on everything except ${LATE_MIGRATIONS[*]}"
UPGRADE_RESULT1="$("${MIGRATE_RUNNER[@]}" "$FX_UPGRADE_URL" "$UPGRADE_MIGRATIONS_DIR")"
UPGRADE_APPLIED1_SORTED="$(echo "$UPGRADE_RESULT1" | jq -r '.applied | sort | .[]')"
if [ "$UPGRADE_APPLIED1_SORTED" != "$MAIN_CHAIN_FILES" ]; then
  echo "neon-shape: upgrade path's first batch did not match the pre-late-migrations file list" >&2
  echo "--- applied ---"; echo "$UPGRADE_APPLIED1_SORTED" >&2
  echo "--- expected ---"; echo "$MAIN_CHAIN_FILES" >&2
  exit 1
fi

# End-state assertion the reviewer asked for, checked BEFORE the late
# migrations land too -- 0200 already revoked CREATE at this point on a
# database shaped exactly like this.
UPGRADE_CREATE_MID="$("${PSQL[@]}" -U fx_migrator -d fx_upgrade -tA -c \
  "SELECT has_schema_privilege('platform_ops','public','CREATE');")"
if [ "$UPGRADE_CREATE_MID" != "f" ]; then
  echo "neon-shape: platform_ops still has CREATE on public after the pre-late-migrations batch (expected f, got $UPGRADE_CREATE_MID)" >&2
  exit 1
fi

echo "==> upgrade path: applying ${LATE_MIGRATIONS[*]} one at a time, the way a live Neon database would receive them"
for late in "${LATE_MIGRATIONS[@]}"; do
  cp "$MIGRATIONS_DIR/$late" "$UPGRADE_MIGRATIONS_DIR/$late"
done
UPGRADE_RESULT2="$("${MIGRATE_RUNNER[@]}" "$FX_UPGRADE_URL" "$UPGRADE_MIGRATIONS_DIR")"
UPGRADE_APPLIED2_SORTED="$(echo "$UPGRADE_RESULT2" | jq -r '.applied | sort | .[]')"
LATE_MIGRATIONS_SORTED="$(printf '%s\n' "${LATE_MIGRATIONS[@]}" | sort)"
if [ "$UPGRADE_APPLIED2_SORTED" != "$LATE_MIGRATIONS_SORTED" ]; then
  echo "neon-shape: upgrade path's second batch did not apply exactly the late migrations" >&2
  echo "--- applied ---"; echo "$UPGRADE_APPLIED2_SORTED" >&2
  echo "--- expected ---"; echo "$LATE_MIGRATIONS_SORTED" >&2
  exit 1
fi

# criterion (D#81 fix round MUST-FIX): the reviewer's required end-state
# assertion, on the Neon-shaped role, after the full upgrade sequence --
# platform_ops still has no CREATE on public, and fx_migrator still
# doesn't INHERIT platform_ops.
UPGRADE_CREATE_END="$("${PSQL[@]}" -U fx_migrator -d fx_upgrade -tA -c \
  "SELECT has_schema_privilege('platform_ops','public','CREATE');")"
UPGRADE_INHERIT_END="$("${PSQL[@]}" -U fx_migrator -d fx_upgrade -tA -c \
  "SELECT pg_has_role('fx_migrator','platform_ops','USAGE');")"
if [ "$UPGRADE_CREATE_END" != "f" ] || [ "$UPGRADE_INHERIT_END" != "f" ]; then
  echo "neon-shape: upgrade-path end state wrong (platform_ops CREATE=$UPGRADE_CREATE_END, fx_migrator INHERIT platform_ops=$UPGRADE_INHERIT_END; both must be f)" >&2
  exit 1
fi
# DS-0a item 4: the same discussion_eraser INHERIT/shape check, on the
# upgrade path. A no-op today (discussion_eraser doesn't exist on main).
check_eraser_role_shape fx_upgrade
check_receipt_writer_role_shape fx_upgrade

# A second run over the same (now fully caught-up) dir is still a no-op,
# same invariant as the fresh path's own re-run check.
UPGRADE_RESULT3="$("${MIGRATE_RUNNER[@]}" "$FX_UPGRADE_URL" "$UPGRADE_MIGRATIONS_DIR")"
UPGRADE_APPLIED3_COUNT="$(echo "$UPGRADE_RESULT3" | jq '.applied | length')"
if [ "$UPGRADE_APPLIED3_COUNT" -ne 0 ]; then
  echo "neon-shape: upgrade path's third (re-)run against fx_upgrade was not a no-op: $UPGRADE_RESULT3" >&2
  exit 1
fi

# D#94 R1: generic base-driven upgrade-vs-fresh parity, using the same
# base resolution as check-migration-order.sh's step 1 (same fail-closed
# behavior on an unresolvable base). Unlike the LATE_MIGRATIONS batch
# above -- specific, already-proven-safe historical files -- this proves
# THIS PR's own added migration files, if any, are safe under a real
# upgrade: migrate the base's own chain first, then run the runner again
# pointed at HEAD's directory so only the files this PR added actually
# apply, and diff the result against fx_neon (already migrated above --
# "a fresh database with HEAD's full chain") instead of standing up a
# third from-scratch fresh database just to compare against.
echo "==> D#94: base-driven upgrade-vs-fresh parity check"
D94_BASE_REF="${MIGRATION_ORDER_BASE:-origin/main}"
if ! D94_MERGE_BASE="$(git -C "$REPO_ROOT" merge-base HEAD "$D94_BASE_REF" 2>/dev/null)"; then
  echo "neon-shape: cannot resolve base $D94_BASE_REF — refusing to pass" >&2
  exit 2
fi

# Base's own chain, read from the base ref's git object (not this
# worktree's disk, which can be behind $D94_BASE_REF).
D94_BASE_FILES="$(git -C "$REPO_ROOT" ls-tree --name-only "${D94_MERGE_BASE}:packages/db/migrations" 2>/dev/null | grep -E '\.sql$' || true)"
D94_BASE_DIR="$PG_TMP_DIR/d94_base_migrations"
mkdir -p "$D94_BASE_DIR"
for f in $D94_BASE_FILES; do
  git -C "$REPO_ROOT" show "${D94_MERGE_BASE}:packages/db/migrations/${f}" > "$D94_BASE_DIR/$f"
done

"${PSQL[@]}" -U postgres -d postgres -c "CREATE DATABASE fx_d94_parity OWNER fx_migrator;"
FX_D94_PARITY_URL="postgres://fx_migrator@127.0.0.1:${PG_PORT}/fx_d94_parity?host=${PG_TMP_DIR}"

echo "==> D94 parity: migrating fx_d94_parity on the base's own chain"
"${MIGRATE_RUNNER[@]}" "$FX_D94_PARITY_URL" "$D94_BASE_DIR" >/dev/null

echo "==> D94 parity: running HEAD's runner again, so only this PR's added files apply"
D94_UPGRADE_RESULT="$("${MIGRATE_RUNNER[@]}" "$FX_D94_PARITY_URL" "$MIGRATIONS_DIR")"
D94_UPGRADE_APPLIED_SORTED="$(echo "$D94_UPGRADE_RESULT" | jq -r '.applied | sort | .[]')"
D94_ADDED_SORTED="$(git -C "$REPO_ROOT" diff --name-status -M --diff-filter=A "$D94_MERGE_BASE" HEAD -- 'packages/db/migrations/*.sql' | cut -f2 | xargs -n1 basename 2>/dev/null | sort || true)"
if [ "$D94_UPGRADE_APPLIED_SORTED" != "$D94_ADDED_SORTED" ]; then
  echo "neon-shape: D#94 parity -- fx_d94_parity's second batch did not match this PR's added files" >&2
  echo "--- applied ---"; echo "$D94_UPGRADE_APPLIED_SORTED" >&2
  echo "--- expected (added) ---"; echo "$D94_ADDED_SORTED" >&2
  exit 1
fi

echo "==> D94 parity: diffing neon-shape-catalog.sql between fx_d94_parity (upgrade path) and fx_neon (fresh path)"
"${PSQL[@]}" -U fx_migrator -d fx_d94_parity -A -F'|' -f "$CATALOG_SQL" > "$PG_TMP_DIR/catalog_d94_parity.txt"
if ! diff -u "$PG_TMP_DIR/catalog_d94_parity.txt" "$PG_TMP_DIR/catalog_neon.txt"; then
  echo "neon-shape: D#94 parity check FAILED (base-then-added upgrade vs fresh, see diff above)" >&2
  exit 1
fi

D94_CREATE_END="$("${PSQL[@]}" -U fx_migrator -d fx_d94_parity -tA -c \
  "SELECT has_schema_privilege('platform_ops','public','CREATE');")"
D94_INHERIT_END="$("${PSQL[@]}" -U fx_migrator -d fx_d94_parity -tA -c \
  "SELECT pg_has_role('fx_migrator','platform_ops','USAGE');")"
if [ "$D94_CREATE_END" != "f" ] || [ "$D94_INHERIT_END" != "f" ]; then
  echo "neon-shape: D#94 parity end state wrong (platform_ops CREATE=$D94_CREATE_END, fx_migrator INHERIT platform_ops=$D94_INHERIT_END; both must be f)" >&2
  exit 1
fi
# DS-0a item 4: the same discussion_eraser INHERIT/shape check, on the
# D#94 parity path. A no-op today (discussion_eraser doesn't exist on main).
check_eraser_role_shape fx_d94_parity
check_receipt_writer_role_shape fx_d94_parity

ELAPSED=$((SECONDS - SCRIPT_START))
echo "neon-shape: runtime ${ELAPSED}s"
echo "neon-shape: OK"
