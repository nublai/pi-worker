# Sourced by kernel.sh (and its harness test): the piw-* user units still left after the kernel suite.
#
# Right after `systemd-run --wait --collect` returns, systemd can still list the wrapper's own service while it unloads
# it (`systemctl stop` on it then says "Unit ... not loaded"; kernel.yml run 43893196124). So the check polls, bounded:
# a unit that is no longer listed, or whose load state is not `loaded` (not-found: it is gone), is not a leftover; a
# unit still loaded in any state is retried until the bound. Whatever is still loaded at the bound is a real leftover
# and is printed as `unit:load/active/sub`, one per line. Nothing is hidden: an active, failed or stuck unit that
# outlives the bound is reported, and the bound only delays that report.
#
#   piw_leftover_units [tries=50] [interval_seconds=0.2]
piw_leftover_units() {
  local tries=${1:-50} interval=${2:-0.2} n=0 left
  while :; do
    # --plain may still print a status bullet for a failed or not-found unit: drop it before reading the columns.
    left=$(systemctl --user list-units --all --plain --no-legend 'piw-*' |
      awk '{ if ($1 == "●" || $1 == "*") $1 = ""; $0 = $0; if ($2 == "loaded") print $1 ":" $2 "/" $3 "/" $4 }')
    [ -n "$left" ] || return 0
    n=$((n + 1))
    if [ "$n" -ge "$tries" ]; then
      printf '%s\n' "$left"
      return 0
    fi
    sleep "$interval"
  done
}
