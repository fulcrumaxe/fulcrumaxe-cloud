# shellcheck shell=bash
# Loader for the per-migration entries of test-neon-shape.sh (packages/db/neon-shape.d/<migration>.conf).
#
# Entries are DATA, never code: they are not sourced or evaluated. Every line of every entry is checked
# against a strict allowlist before anything is registered, and a line that does not match is refused with
# its file and line number. The check functions an entry names (check_*) are defined in test-neon-shape.sh;
# an entry only registers them. A migration that needs a new check function adds it to that script.
#
# Line grammar (one directive per line; blank lines and lines starting with # are ignored; arguments are
# separated by single spaces and may use only letters, digits and _ . , ( ) [ ] @ : -):
#
#   role <role>...                         roles the migration creates (derived-set check in the script)
#   exempt <label> <fn> [arg...]           SECURITY DEFINER exemption: runs `<fn> fx_neon [arg...]`, which prints
#                                          oid(s) (a comma list is fine) or SHAPE_FAIL:<why>
#   exempt_single <label> <fn> [arg...]    the same, but the output must be exactly one oid
#   check <fn> [arg...]                    runs `<fn> fx_neon [arg...]` against the fresh-chain database
#   check_everywhere <fn> [arg...]         the same, and also on the upgrade-path and D#94 databases
#   late                                   hold the migration back on the upgrade path
#   functions <PREFIX> <name>...           sets <PREFIX>_FUNCTIONS to the quoted, comma-separated names
#   privilege <PREFIX> <word>...           appends one quoted privilege (e.g. column agent_runs.id SELECT) to
#                                          <PREFIX>_PRIVILEGES
#
# An exempt argument @FUNCTIONS:<PREFIX> stands for the value of <PREFIX>_FUNCTIONS set by an earlier
# `functions` line. <fn> must be check_ followed by lowercase letters, digits and underscores.

NS_EXEMPT_LABELS=()
NS_EXEMPT_MODES=()
NS_EXEMPT_CMDS=()
NS_CHECK_CMDS=()
NS_CHECK_SCOPES=()
NS_DECLARED_ROLES=()
NS_LATE_MIGRATIONS=()
NS_ENTRY_FILES=()
NS_ENTRY_COUNT=0
NS_REASON=""
NS_LINE_RE='^[]A-Za-z0-9_.,()@: [-]+$'

ns_refuse() {
  echo "neon-shape: $*" >&2
  exit 1
}

# Fills NS_ENTRY_FILES with the entry files of <dir>, sorted. Refuses a symlinked or missing directory, a
# symlink, a directory, a hidden file, and any name that is not <NNNN>_<name>.conf.
ns_list_entry_files() {
  local dir="$1" f name
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    ns_refuse "entry directory $dir is missing or is a symlink"
  fi
  NS_ENTRY_FILES=()
  while IFS= read -r -d '' f; do
    name="${f##*/}"
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      ns_refuse "$f is not a regular file (entries must be plain files; no symlinks, no directories)"
    fi
    if ! [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.conf$ ]]; then
      ns_refuse "$f is not named <NNNN>_<migration name>.conf; the entry directory holds nothing else"
    fi
    NS_ENTRY_FILES+=("$f")
  done < <(command find "$dir" -mindepth 1 -maxdepth 1 -print0 | LC_ALL=C command sort -z)
  if [ "${#NS_ENTRY_FILES[@]}" -eq 0 ]; then
    ns_refuse "no entries found in $dir"
  fi
}

# Sets NS_REASON and returns 1 when the line is not on the allowlist.
ns_check_line() {
  local line="$1" words=() directive n
  if [ -z "$line" ] || [[ "$line" == "#"* ]]; then
    return 0
  fi
  if ! [[ "$line" =~ $NS_LINE_RE ]]; then
    NS_REASON="characters outside the allowlist (letters, digits and _ . , ( ) [ ] @ : - and single spaces)"
    return 1
  fi
  if [[ "$line" == " "* || "$line" == *" " || "$line" == *"  "* ]]; then
    NS_REASON="leading, trailing or repeated spaces"
    return 1
  fi
  read -r -a words <<<"$line"
  directive="${words[0]}"
  n=$((${#words[@]} - 1))
  case "$directive" in
    role | check | check_everywhere)
      [ "$n" -ge 1 ] || { NS_REASON="$directive needs at least one argument"; return 1; }
      ;;
    exempt | exempt_single)
      [ "$n" -ge 2 ] || { NS_REASON="$directive needs a label and a check function"; return 1; }
      [[ "${words[1]}" =~ ^[a-z0-9_]+$ ]] || { NS_REASON="bad label '${words[1]}'"; return 1; }
      ;;
    late)
      [ "$n" -eq 0 ] || { NS_REASON="late takes no arguments"; return 1; }
      ;;
    functions | privilege)
      [ "$n" -ge 2 ] || { NS_REASON="$directive needs a prefix and at least one more word"; return 1; }
      [[ "${words[1]}" =~ ^[A-Z][A-Z0-9_]*$ ]] || { NS_REASON="bad prefix '${words[1]}'"; return 1; }
      ;;
    *)
      NS_REASON="unknown directive '$directive'"
      return 1
      ;;
  esac
  case "$directive" in
    check | check_everywhere)
      [[ "${words[1]}" =~ ^check_[a-z0-9_]+$ ]] || { NS_REASON="'${words[1]}' is not a check_ function name"; return 1; }
      ;;
    exempt | exempt_single)
      [[ "${words[2]}" =~ ^check_[a-z0-9_]+$ ]] || { NS_REASON="'${words[2]}' is not a check_ function name"; return 1; }
      ;;
  esac
  return 0
}

# Registers one already-validated line of the entry for migration $NS_CURRENT_MIGRATION.
ns_apply_line() {
  local file="$1" line="$2" words=() directive prefix var cur item i arg args=() fnvar
  if [ -z "$line" ] || [[ "$line" == "#"* ]]; then
    return 0
  fi
  read -r -a words <<<"$line"
  directive="${words[0]}"
  case "$directive" in
    role)
      NS_DECLARED_ROLES+=("${words[@]:1}")
      ;;
    exempt | exempt_single)
      for ((i = 3; i < ${#words[@]}; i++)); do
        arg="${words[i]}"
        if [[ "$arg" == @FUNCTIONS:* ]]; then
          prefix="${arg#@FUNCTIONS:}"
          [[ "$prefix" =~ ^[A-Z][A-Z0-9_]*$ ]] || ns_refuse "$file: bad prefix in $arg"
          fnvar="${prefix}_FUNCTIONS"
          [ -n "${!fnvar:-}" ] || ns_refuse "$file: $arg used before a 'functions $prefix' line"
          arg="${!fnvar}"
        fi
        args+=("$arg")
      done
      NS_EXEMPT_LABELS+=("${words[1]}")
      NS_EXEMPT_MODES+=("$([ "$directive" = exempt_single ] && echo single || echo list)")
      NS_EXEMPT_CMDS+=("$(printf '%q ' "${words[2]}" fx_neon "${args[@]}")")
      ;;
    check | check_everywhere)
      NS_CHECK_CMDS+=("$(printf '%q ' "${words[1]}" @DB@ "${words[@]:2}")")
      NS_CHECK_SCOPES+=("$([ "$directive" = check_everywhere ] && echo everywhere || echo neon)")
      ;;
    late)
      NS_LATE_MIGRATIONS+=("$NS_CURRENT_MIGRATION")
      ;;
    functions)
      prefix="${words[1]}"
      cur=""
      for ((i = 2; i < ${#words[@]}; i++)); do
        cur+="${cur:+, }'${words[i]}'"
      done
      printf -v "${prefix}_FUNCTIONS" '%s' "$cur"
      ;;
    privilege)
      prefix="${words[1]}"
      var="${prefix}_PRIVILEGES"
      cur="${!var:-}"
      item="${words[*]:2}"
      printf -v "$var" '%s' "${cur:+$cur,}'$item'"
      ;;
  esac
}

# ns_load_entries <entry dir> <migrations dir> <strict>
# Pass 1 validates every line of every entry (nothing is registered if any line is refused); pass 2 registers
# them in sorted order. With strict=1 an entry whose migration is missing from <migrations dir> is refused;
# with strict=0 (an overridden MIGRATIONS_DIR) it is skipped.
ns_load_entries() {
  local dir="$1" migrations_dir="$2" strict="$3" file lineno line
  ns_list_entry_files "$dir"
  for file in "${NS_ENTRY_FILES[@]}"; do
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))
      if ! ns_check_line "$line"; then
        ns_refuse "$file:$lineno: refused: $NS_REASON"
      fi
    done <"$file"
  done
  NS_ENTRY_COUNT=0
  for file in "${NS_ENTRY_FILES[@]}"; do
    NS_CURRENT_MIGRATION="$(basename "$file" .conf).sql"
    if [ ! -f "$migrations_dir/$NS_CURRENT_MIGRATION" ]; then
      if [ "$strict" = 1 ]; then
        ns_refuse "entry $file has no migration $NS_CURRENT_MIGRATION in $migrations_dir"
      fi
      continue
    fi
    NS_ENTRY_COUNT=$((NS_ENTRY_COUNT + 1))
    while IFS= read -r line || [ -n "$line" ]; do
      ns_apply_line "$file" "$line"
    done <"$file"
  done
}

# Runs every registered exemption (a check_* function printing oid(s)) and sets EXEMPT_FILTER to the list of
# oids the owner scan lets through ("0" is always present, so the list is never empty).
ns_run_exempts() {
  local i label fn result
  EXEMPT_FILTER="0"
  for ((i = 0; i < ${#NS_EXEMPT_CMDS[@]}; i++)); do
    label="${NS_EXEMPT_LABELS[i]}"
    fn="${NS_EXEMPT_CMDS[i]%% *}"
    declare -F "$fn" >/dev/null || ns_refuse "exemption '$label' names $fn, which test-neon-shape.sh does not define"
    result="$(eval "${NS_EXEMPT_CMDS[i]}")"
    if [[ "$result" == SHAPE_FAIL:* ]]; then
      ns_refuse "${result#SHAPE_FAIL:}"
    fi
    if [ "${NS_EXEMPT_MODES[i]}" = single ]; then
      if [ -n "$result" ] && ! [[ "$result" =~ ^[0-9]+$ ]]; then
        ns_refuse "internal error -- $label exempt function oid was not numeric: $result"
      fi
    elif [ -n "$result" ] && ! [[ "$result" =~ ^[0-9]+(,\ [0-9]+)*$ ]]; then
      ns_refuse "internal error -- $label exempt function oid(s) were not numeric: $result"
    fi
    EXEMPT_FILTER+=", ${result:-0}"
  done
}

# ns_run_checks <all|everywhere> <db>: "all" runs every registered check, "everywhere" only the
# check_everywhere ones.
ns_run_checks() {
  local scope="$1" db="$2" i cmd fn
  for ((i = 0; i < ${#NS_CHECK_CMDS[@]}; i++)); do
    if [ "$scope" = all ] || [ "${NS_CHECK_SCOPES[i]}" = everywhere ]; then
      cmd="${NS_CHECK_CMDS[i]//@DB@/$db}"
      fn="${cmd%% *}"
      declare -F "$fn" >/dev/null || ns_refuse "an entry names check $fn, which test-neon-shape.sh does not define"
      eval "$cmd"
    fi
  done
}

# Called from the EXIT trap with the exit status. A run that exits 0 without having reached the final step
# (NS_COMPLETED=1, set just before the OK line) is a failure: an early `exit 0` cannot pass the gate.
ns_exit_guard() {
  if [ "$1" -eq 0 ] && [ "${NS_COMPLETED:-0}" != 1 ]; then
    echo "neon-shape: exited 0 without completing every check -- refusing to pass" >&2
    return 1
  fi
  return 0
}

readonly -f ns_refuse ns_list_entry_files ns_check_line ns_apply_line ns_load_entries ns_run_exempts ns_run_checks ns_exit_guard
