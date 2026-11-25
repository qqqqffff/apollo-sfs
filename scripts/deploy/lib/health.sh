# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/health.sh — health checks + the heartbeat with the manager (WS3b).
#
# Heartbeat = this node sends its node.json view (metrics + the drives it
# expects to report) to the manager; the manager checks what IT sees: swarm
# state, running tasks, the app DB `nodes` row, and — per drive — that
# node-agent's last report is fresh (< 20 s, the API's own staleness rule),
# comes from the right device, and has the right capacity (±1 %). Freshness
# alone is not enough: an unmounted drive's empty mountpoint gets reported as
# the root filesystem under the drive's label.
# ─────────────────────────────────────────────────────────────────────────────

HEALTH_STALE_S=20
declare -ga HEALTH_CHECKS=()   # "name|pass|warn|fail|detail"
HEARTBEAT_LAST=""

_health_add() { HEALTH_CHECKS+=("$1|$2|$3"); }

# _health_table — print HEALTH_CHECKS; rc 1 if any failed.
_health_table() {
  local -a rows=("CHECK|STATUS|DETAIL") c n st d bad=0
  for c in "${HEALTH_CHECKS[@]+"${HEALTH_CHECKS[@]}"}"; do
    IFS='|' read -r n st d <<<"$c"
    [[ "$st" == fail ]] && bad=1
    rows+=("$n|$st|$d")
  done
  ui_table "${rows[@]}"
  return "$bad"
}

_health_checks_json() {
  local c n st d out="[" first=1
  for c in "${HEALTH_CHECKS[@]+"${HEALTH_CHECKS[@]}"}"; do
    IFS='|' read -r n st d <<<"$c"
    [[ $first == 1 ]] || out+=","; first=0
    out+="{\"name\":$(json_escape "$n"),\"status\":$(json_escape "$st"),\"detail\":$(json_escape "$d")}"
  done
  printf '%s]' "$out"
}

_health_result() {
  local c st r=pass
  for c in "${HEALTH_CHECKS[@]+"${HEALTH_CHECKS[@]}"}"; do
    st="$(cut -d'|' -f2 <<<"$c")"
    [[ "$st" == fail ]] && { printf fail; return; }
    [[ "$st" == warn ]] && r=warn
  done
  printf '%s' "$r"
}

# ── local checks ─────────────────────────────────────────────────────────────
_health_check_node_json() {
  if is_test && [[ -z "$FIXTURES" && -f "$NODE_JSON_REAL" ]]; then
    local e; e="$(py json get --file "$NODE_JSON_REAL" --key last_updated_epoch --default 0 2>/dev/null)"
    [[ "$e" =~ ^[0-9]+$ ]] || e=0
    if (( e > 0 && $(now_epoch) - e <= 15 )); then _health_add node.json pass "updated $(( $(now_epoch) - e ))s ago (live file)"
    else _health_add node.json warn "[test] live node.json not fresh (service not running yet?)"; fi
    return 0
  fi
  if is_test; then _health_add node.json pass "[test] skipped (sandbox copy)"; return 0; fi
  local out rc=0
  out="$(py validate --file "$NODE_JSON" --max-age 15 --text 2>/dev/null)" || rc=$?
  if grep -q 'metrics' <<<"$out"; then
    _health_add node.json fail "$(grep '^R .*metrics' <<<"$out" | head -n1 | cut -c3-)"
  else
    _health_add node.json pass "updated every 5 s by apollo-node-status"
  fi
  return 0
}

# Drive thresholds (°C): warn / fail. NVMe controllers throttle around 70–80 °C;
# spinning disks are rated to ~60 °C.
HEALTH_TEMP_FLASH_WARN=70; HEALTH_TEMP_FLASH_FAIL=80
HEALTH_TEMP_HDD_WARN=50;   HEALTH_TEMP_HDD_FAIL=60
# Space: warn at 90 % used (the collector's own alert), fail at 95 %.
HEALTH_SPACE_WARN=90; HEALTH_SPACE_FAIL=95

# _health_drive_metrics — print a metrics JSON object that covers this node's
# drives and pools, measured NOW:
#   real: waits for apollo-node-status to rewrite node.json (≤ 30 s) and for
#         every recorded drive to appear in metrics.disks.
#   test: one read-only `collect --once` against the planned deployment, so the
#         existing drives are really measured (nothing is written).
_health_drive_metrics() {
  if is_test; then
    local -a hr=()
    if [[ -n "$FIXTURES" ]]; then
      if [[ -d "$FIXTURES/hostroot" ]]; then hr=(--host-root "$FIXTURES/hostroot")
      else node_json_get metrics '{}' 2>/dev/null; return 0; fi
    fi
    local out
    if out="$(py collect --once --node-json "$NODE_JSON" --repo "$APOLLO_ROOT" "${hr[@]+"${hr[@]}"}" 2>/dev/null)"; then
      printf '%s' "$out" | json_get metrics '{}'
    else
      node_json_get metrics '{}' 2>/dev/null
    fi
    return 0
  fi
  local want deadline have
  want="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(" ".join(sorted(d["label"] for d in json.load(sys.stdin) if d.get("label") and not d.get("unassigned"))))')"
  nodestatus_wait_fresh 10 30 >/dev/null 2>&1 || log_warn "node.json is not being refreshed — is $NODESTATUS_UNIT running?"
  deadline=$(( $(now_epoch) + 30 ))
  while :; do
    have="$(node_json_get metrics.disks '[]' | python3 -I -c 'import json,sys; print(" ".join(sorted(d["label"] for d in json.load(sys.stdin) if d.get("label") and d.get("total_bytes"))))')"
    local missing="" l
    for l in $want; do [[ " $have " == *" $l "* ]] || missing+="$l "; done
    [[ -z "$missing" ]] && break
    (( $(now_epoch) >= deadline )) && break
    sleep 2
  done
  node_json_get metrics '{}' 2>/dev/null
}

# health_show_sample METRICS_JSON — print a table of one metrics sample
# (per drive: device, temperature, SMART, used/free, I/O; per pool: branches).
health_show_sample() {
  local m="${1:-{\}}" rows
  rows="$(python3 -I -c '
import json, sys
m = json.loads(sys.argv[1] or "{}")
def fmt(n):
    if n is None: return "n/a"
    n = float(n)
    for u in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1000 or u == "PB": return ("%d B" % n) if u == "B" else "%.1f %s" % (n, u)
        n /= 1000.0
for d in m.get("disks") or []:
    t = d.get("temp_celsius")
    print("drive %s|%s|%s|%s|%s|%s / %s (%s%%)|r %s/s w %s/s" % (
        d.get("label"), d.get("device") or "not mounted", "%s°C" % t if t is not None else "n/a",
        d.get("smart_health") or "unknown", "mounted" if d.get("mounted") else "UNMOUNTED",
        fmt(d.get("used_bytes")), fmt(d.get("total_bytes")), d.get("used_percent", "n/a"),
        fmt(d.get("read_bps")), fmt(d.get("write_bps"))))
for p in m.get("pools") or []:
    print("pool %s|%s|—|—|%s|%s / %s|branches %s" % (p.get("tier"), p.get("path"),
        "mounted" if p.get("mounted") else "UNMOUNTED", fmt(p.get("used_bytes")), fmt(p.get("total_bytes")),
        len(p.get("branches") or []) if p.get("branches") is not None else "n/a"))
' "$m" 2>/dev/null)"
  if [[ -z "$rows" ]]; then log_detail "sample: no drive or pool measurements available yet"; return 0; fi
  local -a t=("SAMPLE|DEVICE|TEMP|SMART|STATE|USED / TOTAL|I/O")
  local l; while IFS= read -r l; do t+=("$l"); done <<<"$rows"
  ui_table "${t[@]}"
}

# _health_check_drives — per drive: metrics present, mounted, SMART health,
# temperature and free space; per pool: mounted, branches, free space.
# Missing metrics FAIL (also in --test for drives that already exist; drives
# that are only planned in this test run are reported as "planned").
_health_check_drives() {
  local drives metrics
  drives="$(node_json_get deployment.drives '[]' 2>/dev/null)"
  [[ "$drives" == "[]" ]] && { _health_add drives pass "no drives on this node"; return 0; }
  log_info "Measuring drive health, temperatures and free space…"
  metrics="$(_health_drive_metrics)"
  while IFS='|' read -r name st detail; do
    [[ -n "$name" ]] && _health_add "$name" "$st" "$detail"
  done < <(python3 -I -c '
import json, sys
drives = json.loads(sys.argv[1] or "[]")
metrics = json.loads(sys.argv[2] or "{}")
pools = json.loads(sys.argv[3] or "[]")
test, root = sys.argv[4] == "1", sys.argv[5] == "1"
fw, ff, hw, hf, sw, sf = (int(x) for x in sys.argv[6:12])

def fmt(n):
    if not n:
        return "0 B"
    for u in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1000 or u == "PB":
            return ("%.1f %s" % (n, u)) if u != "B" else "%d B" % n
        n /= 1000.0

def planned(d):
    return str(d.get("uuid") or "").startswith("planned")

def space(m):
    tot, free, pct = m.get("total_bytes"), m.get("free_bytes"), m.get("used_percent")
    if not tot or free is None:
        return "fail", "no capacity reading"
    if pct is None:
        pct = round(100.0 * (tot - free) / tot, 1)
    st = "fail" if pct >= sf else "warn" if pct >= sw else "pass"
    return st, "%s free of %s (%s%% used)" % (fmt(free), fmt(tot), pct)

worst = {"pass": 0, "planned": 0, "warn": 1, "fail": 2}
def merge(*sts):
    return max(sts, key=lambda s: worst.get(s, 0))

disks = {d.get("label"): d for d in metrics.get("disks") or []}
planned_dirs = set()
for d in drives:
    if d.get("unassigned"):
        continue
    lab = d.get("label")
    if planned(d):
        planned_dirs.add(d.get("data_dir"))
        print("drive %s|planned|formatted in this run — measured once it exists (real run)" % lab)
        continue
    m = disks.get(lab)
    if m is None or (m.get("mounted") and not m.get("total_bytes")):
        print("drive %s|fail|no metrics for this drive (apollo-node-status does not report it)" % lab); continue
    if not m.get("mounted"):
        print("drive %s|fail|not mounted at %s" % (lab, d.get("mountpoint"))); continue
    flash = (d.get("class") or "nvme") != "hdd"
    # health
    sh = m.get("smart_health") or "unknown"
    if sh == "FAILED":
        hs, hd = "fail", "SMART FAILED"
    elif sh == "PASSED":
        hs, hd = "pass", "SMART ok"
    elif not root:
        hs, hd = "warn", "SMART not readable without root (run with sudo)"
    else:
        hs, hd = "warn", "SMART health unavailable (%s)" % sh
    # temperature
    t = m.get("temp_celsius")
    w, f = (fw, ff) if flash else (hw, hf)
    if t is None:
        ts, td = ("fail" if (flash and d.get("class") == "nvme") else "warn"), "no temperature reading"
    else:
        ts = "fail" if t >= f else "warn" if t >= w else "pass"
        td = "%s°C" % t + (" (limit %s°C)" % f if ts != "pass" else "")
    ss, sd = space(m)
    print("drive %s|%s|%s · %s · %s · %s" % (lab, merge(hs, ts, ss), m.get("device"), hd, td, sd))

mp = {p.get("path"): p for p in metrics.get("pools") or []}
for p in pools:
    tier, path = p.get("tier"), p.get("path")
    want = p.get("branches") or []
    m = mp.get(path)
    if m is None:
        print("pool %s|fail|no metrics for %s" % (tier, path)); continue
    if not m.get("mounted"):
        print("pool %s|fail|%s is not mounted (MinIO stays down)" % (tier, path)); continue
    have = m.get("branches")
    note = "%d branches" % len(have or want)
    if have is None:
        st, note = "fail", "branch list unreadable (.mergerfs xattr)"
    elif sorted(have) != sorted(want):
        extra = sorted(set(want) - set(have))
        if test and set(have) <= set(want) and all(b in planned_dirs for b in extra):
            st, note = "planned", "%d branches now, %d after this run (adds %s)" % (len(have), len(want), ", ".join(extra))
        else:
            st, note = "fail", "branches %s differ from the recorded %s" % (have, want)
    else:
        st = "pass"
    ss, sd = space(m)
    print("pool %s|%s|%s · %s · %s" % (tier, merge(st, ss), path, note, sd))
' "$drives" "${metrics:-{\}}" "$(node_json_get deployment.pools '[]' 2>/dev/null)" \
    "$([[ $TEST_MODE == 1 ]] && echo 1 || echo 0)" "$([[ $EUID -eq 0 ]] && echo 1 || echo 0)" \
    "$HEALTH_TEMP_FLASH_WARN" "$HEALTH_TEMP_FLASH_FAIL" "$HEALTH_TEMP_HDD_WARN" "$HEALTH_TEMP_HDD_FAIL" \
    "$HEALTH_SPACE_WARN" "$HEALTH_SPACE_FAIL")
  return 0
}

_health_check_services() {
  local role; role="$(node_role)"
  if [[ "$role" == manager ]]; then
    local svcs; svcs="$(probe docker-stack-services-replicas -- docker stack services "$STACK_NAME" --format '{{.Name}} {{.Replicas}}' 2>/dev/null || true)"
    if [[ -z "$svcs" ]]; then
      _health_add services "$(is_test && echo warn || echo fail)" "the $STACK_NAME stack is not running"
      return 0
    fi
    local bad n=0
    bad="$(awk '{ split($2, r, "/"); if (r[1] != r[2]) printf "%s(%s) ", $1, $2 }' <<<"$svcs")"
    n="$(grep -c . <<<"$svcs")"
    if [[ -n "$bad" ]]; then _health_add services fail "not converged: $bad"
    else _health_add services pass "$n services converged"; fi
  else
    local expected; expected="$(node_json_get deployment.stack.services '[]' 2>/dev/null | tr -d '[]"' | tr ',' ' ')"
    local running; running="$(probe docker-ps-services -- docker ps --format '{{.Label "com.docker.swarm.service.name"}}' 2>/dev/null | sort -u)"
    local s missing=""
    for s in $expected; do grep -qx "${STACK_NAME}_$s" <<<"$running" || missing+="$s "; done
    if [[ -z "$expected" ]]; then _health_add services warn "no services recorded for this node yet"
    elif [[ -n "$missing" ]]; then _health_add services fail "not running here: $missing"
    else _health_add services pass "running: $expected"; fi
  fi
  local unhealthy; unhealthy="$(probe docker-ps-unhealthy -- docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | paste -sd' ' -)"
  [[ -n "$unhealthy" ]] && _health_add containers fail "unhealthy: $unhealthy"
  return 0
}

# _health_check_http — manager-local probes: api, keycloak, frontend, nginx TLS.
_health_check_http() {
  [[ "$(node_role)" == manager ]] || return 0
  manager_env_load >/dev/null 2>&1 || true
  local realm="${KEYCLOAK_REALM:-apollo-sfs-realm}" domain
  domain="${APP_BASE_URL:-}"; domain="${domain#https://}"; domain="${domain%%/*}"
  if probe http-api-health -- curl -fsS -m 5 -o /dev/null http://127.0.0.1:8080/api/v1/health 2>/dev/null; then
    _health_add "api" pass "127.0.0.1:8080/api/v1/health"
  else _health_add "api" "$(is_test && echo warn || echo fail)" "api health endpoint not answering"; fi
  if probe http-frontend -- curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
    _health_add "frontend" pass "127.0.0.1:3000"
  else _health_add "frontend" "$(is_test && echo warn || echo fail)" "frontend not answering"; fi
  if probe http-keycloak -- curl -fsS -m 5 -o /dev/null "http://127.0.0.1:8180/realms/$realm/.well-known/openid-configuration" 2>/dev/null; then
    _health_add "keycloak" pass "realm $realm"
  else _health_add "keycloak" "$(is_test && echo warn || echo fail)" "realm $realm not answering on 127.0.0.1:8180"; fi
  if [[ -n "$domain" ]]; then
    # /.well-known/ is deliberately exempt from the GeoIP block, so it's a
    # clean end-to-end check of TLS + nginx from this host.
    if probe http-nginx-tls -- curl -fsSk -m 5 -o /dev/null --resolve "$domain:443:127.0.0.1" \
        "https://$domain/.well-known/microsoft-identity-association.json" 2>/dev/null; then
      _health_add "nginx" pass "https://$domain via 127.0.0.1"
    else _health_add "nginx" "$(is_test && echo warn || echo fail)" "https://$domain not served by local nginx"; fi
  fi
  return 0
}

# ── heartbeat ────────────────────────────────────────────────────────────────
_health_build_heartbeat_request() {
  local f="$1"
  python3 -I -c '
import json, sys
doc = {}
try:
    with open(sys.argv[1]) as fh:
        doc = json.load(fh)
except (OSError, ValueError):
    pass
dep = doc.get("deployment") or {}
metrics = doc.get("metrics") or {}
disks = {d.get("label"): d for d in metrics.get("disks") or []}
expect = []
for d in dep.get("drives") or []:
    if d.get("unassigned"):
        continue
    m = disks.get(d.get("label")) or {}
    expect.append({"label": d.get("label"), "device": m.get("device"), "size_bytes": m.get("total_bytes")})
print(json.dumps({"hostname": sys.argv[2], "swarm_node_id": sys.argv[3], "last_updated_epoch": doc.get("last_updated_epoch"),
                  "metrics": metrics, "expect": {"disks": expect, "services": (dep.get("stack") or {}).get("services") or []}}))
' "$NODE_JSON" "$(node_live_name)" "$(swarm_self_id)" >"$f"
}

# heartbeat_run [--quiet] — one heartbeat (in-process on the manager, over ssh
# on workers). rc 0 pass / 1 fail / 255 manager unreachable.
heartbeat_run() {
  local quiet=0; [[ "${1:-}" == --quiet ]] && quiet=1
  local f rc=0
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-hb.XXXXXX")"
  _health_build_heartbeat_request "$f"
  local -a q=(); [[ $quiet == 1 ]] && q=(--quiet)
  cluster_call heartbeat --in "$f" "${q[@]+"${q[@]}"}" || rc=$?
  rm -f "$f"
  [[ $rc -eq 255 ]] && return 255
  [[ $rc -eq 0 ]] || return 1
  HEARTBEAT_LAST="$MGR_RESPONSE"
  _heartbeat_learn_manager_name
  local ok checks
  ok="$(mgr_data ok false)"
  checks="$(mgr_data checks '[]')"
  if [[ $quiet == 0 ]]; then
    local -a rows=("HEARTBEAT CHECK|STATUS|DETAIL")
    while IFS='|' read -r n st d; do [[ -n "$n" ]] && rows+=("$n|$st|$d"); done < <(printf '%s' "$checks" | python3 -I -c '
import json, sys
for c in json.load(sys.stdin):
    print("%s|%s|%s" % (c.get("name"), c.get("status"), (c.get("detail") or "").replace("|", "/")))')
    ui_table "${rows[@]}"
  fi
  printf '{"heartbeat":{"at":%s,"manager":%s,"result":%s,"checks":%s%s}}' \
    "$(json_escape "$(now_iso)")" "$(json_escape "$(printf '%s' "$MGR_RESPONSE" | json_get host "${MGR_HOST:-self}")")" \
    "$(json_escape "$([[ "$ok" == true ]] && echo pass || echo fail)")" "$checks" \
    "$([[ "$ok" == true ]] && printf ',"last_ok_at":%s' "$(json_escape "$(now_iso)")")" | node_json_merge deployment >/dev/null || true
  [[ "$ok" == true ]]
}

# _heartbeat_learn_manager_name — workers reach the manager by IP, so a renamed
# manager needs no change here; only the name shown in node.json is refreshed.
_heartbeat_learn_manager_name() {
  [[ "$(node_role)" == worker ]] || return 0
  local now old
  now="$(printf '%s' "$MGR_RESPONSE" | json_get host "")"
  old="$(node_json_get deployment.cluster.manager.hostname "" 2>/dev/null || true)"
  [[ "$now" =~ ^[a-z0-9-]{1,63}$ && "$now" != "$old" ]] || return 0
  [[ -z "$old" ]] || log_info "The manager is now called '$now' (was '$old') — recorded in node.json."
  state_set manager_hostname "$now"
  printf '{"cluster":{"manager":{"hostname":%s}}}' "$(json_escape "$now")" | node_json_merge deployment >/dev/null || true
}

# health_wait_disk_metrics [TIMEOUT=60] — wait until the manager sees every
# expected drive reported freshly from the right device with the right size.
# rc 0 ok · 1 failed (last table printed) · 3 can't check yet (no stack/DB).
health_wait_disk_metrics() {
  local timeout="${1:-60}"
  if [[ "$(node_role)" == manager ]] && ! _stack_running; then return 3; fi
  local deadline=$(( $(now_epoch) + timeout )) rc
  while true; do
    rc=0
    heartbeat_run --quiet || rc=$?
    [[ $rc -eq 255 ]] && return 3
    if [[ -n "$HEARTBEAT_LAST" ]]; then
      local verdict
      verdict="$(printf '%s' "$HEARTBEAT_LAST" | python3 -I -c '
import json, sys
d = json.load(sys.stdin).get("data") or {}
checks = d.get("checks") or []
if any(c.get("name") == "nodes_row" and "not running" in (c.get("detail") or "") for c in checks):
    print("defer"); sys.exit()
disk = [c for c in checks if c.get("name", "").startswith("disk ") or c.get("name") in ("nodes_row", "metrics_fresh")]
print("ok" if disk and all(c.get("status") == "pass" for c in disk) else "wait")')"
      [[ "$verdict" == ok ]] && { heartbeat_run >/dev/null 2>&1 || true; _health_print_last; return 0; }
      [[ "$verdict" == defer ]] && return 3
    fi
    is_test && { _health_print_last; return 0; }
    (( $(now_epoch) >= deadline )) && { _health_print_last; return 1; }
    sleep 5
  done
}

_health_print_last() {
  [[ -n "$HEARTBEAT_LAST" ]] || return 0
  local -a rows=("MANAGER SEES|STATUS|DETAIL")
  while IFS='|' read -r n st d; do [[ -n "$n" ]] && rows+=("$n|$st|$d"); done < <(printf '%s' "$HEARTBEAT_LAST" | python3 -I -c '
import json, sys
for c in (json.load(sys.stdin).get("data") or {}).get("checks") or []:
    print("%s|%s|%s" % (c.get("name"), c.get("status"), (c.get("detail") or "").replace("|", "/")))')
  ui_table "${rows[@]}"
}

# _heartbeat_checks HOST REF EXPECT_DISKS_JSON TOLERANCE — what the MANAGER sees
# of one node (appends to HEALTH_CHECKS). REF is what docker commands use: the
# swarm node ID when known, else HOST. Used for a node's own heartbeat and for
# the manager's sweep over its workers.
_heartbeat_checks() {
  local host="$1" ref="$2" expect="$3" tol="$4"
  local st
  st="$(probe "docker-node-state-$(probe_key "$host")" -- docker node inspect "$ref" --format '{{.Status.State}} {{.Spec.Availability}}' 2>/dev/null || true)"
  if [[ "$st" == "ready active" ]]; then _health_add swarm pass "ready, active"
  else _health_add swarm fail "swarm reports '${st:-unknown node}'"; fi
  local tasks; tasks="$(probe "docker-node-ps-state-$(probe_key "$host")" -- docker node ps "$ref" --filter desired-state=running --format '{{.Name}} {{.CurrentState}}' 2>/dev/null || true)"
  local nt nr
  nt="$(grep -c . <<<"$tasks" || true)"; nr="$(grep -c ' Running' <<<"$tasks" || true)"
  if [[ "$nt" == 0 ]]; then _health_add tasks warn "no tasks scheduled on $host"
  elif [[ "$nt" == "$nr" ]]; then _health_add tasks pass "$nr/$nt running"
  else _health_add tasks fail "$nr/$nt running: $(grep -v ' Running' <<<"$tasks" | head -n3 | tr '\n' ';')"; fi

  if [[ -z "$(_stack_db_container)" ]]; then
    _health_add nodes_row warn "db-app not running on the manager — DB checks skipped"
  else
    local row
    row="$(STACK_QUERY_KEY="node-row-$host" stack_db_query "SELECT id FROM nodes WHERE hostname = :'host' AND is_active LIMIT 1" "host=$host" 2>/dev/null || true)"
    if [[ -n "$row" ]]; then _health_add nodes_row pass "registered in the app DB"
    else _health_add nodes_row fail "no active nodes row for $host (its metrics are dropped)"; fi
    local age
    age="$(STACK_QUERY_KEY="node-metrics-age-$host" stack_db_query "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - max(s.sampled_at)))::int, -1) FROM node_metrics_snapshots s JOIN nodes n ON n.id = s.node_id WHERE n.hostname = :'host'" "host=$host" 2>/dev/null || echo -1)"
    age="${age//[^0-9-]/}"
    if [[ "$age" =~ ^[0-9]+$ ]] && (( age < HEALTH_STALE_S )); then _health_add metrics_fresh pass "last node-agent push ${age}s ago"
    else _health_add metrics_fresh fail "no node-agent push within ${HEALTH_STALE_S}s (last: ${age}s)"; fi
    local disks
    disks="$(STACK_QUERY_KEY="node-disks-$host" stack_db_query "SELECT d.label, d.device, d.capacity_bytes, EXTRACT(EPOCH FROM (now() - d.last_seen_at))::int FROM node_disks d JOIN nodes n ON n.id = d.node_id WHERE n.hostname = :'host'" "host=$host" 2>/dev/null || true)"
    while IFS='|' read -r name stt det; do [[ -n "$name" ]] && _health_add "$name" "$stt" "$det"; done < <(
      python3 -I -c '
import json, os, sys
expect = json.loads(sys.argv[1] or "[]")
rows = {}
for line in sys.argv[2].splitlines():
    p = line.split("|")
    if len(p) == 4:
        rows[p[0]] = (p[1], int(p[2] or 0), int(float(p[3] or 0)))
stale, tol = int(sys.argv[3]), float(sys.argv[4])
for e in expect:
    lab = e.get("label")
    r = rows.get(lab)
    if not r:
        print("disk %s|fail|never reported by node-agent" % lab); continue
    dev, cap, age = r
    if age >= stale:
        print("disk %s|fail|last report %ss ago" % (lab, age)); continue
    want_dev = os.path.basename(e.get("device") or "")
    if want_dev and os.path.basename(dev) != want_dev:
        print("disk %s|fail|reported from %s, expected %s (not mounted?)" % (lab, dev, want_dev)); continue
    size = e.get("size_bytes") or 0
    if size and abs(cap - size) > tol * size:
        print("disk %s|fail|capacity %d B vs %d B on the node (>%d%% apart)" % (lab, cap, size, round(tol * 100))); continue
    print("disk %s|pass|%s, %ss ago" % (lab, dev, age))
' "$expect" "$disks" "$HEALTH_STALE_S" "$tol")
  fi
  return 0
}

# remote_op_heartbeat — manager side. Request: {hostname, last_updated_epoch,
# metrics, expect{disks[{label, device, size_bytes}], services[]}}.
remote_op_heartbeat() {
  local host; host="$(remote_req hostname "")"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { remote_fail bad_request "invalid hostname"; return 1; }
  HEALTH_CHECKS=()
  manager_env_load >/dev/null 2>&1 || true
  local STACK_REF="$host"; _stack_node_ref "$host" "$(remote_req swarm_node_id "")"
  _heartbeat_checks "$host" "$STACK_REF" "$(remote_req expect.disks '[]')" 0.01

  local lu skew
  lu="$(remote_req last_updated_epoch 0)"; [[ "$lu" =~ ^[0-9]+$ ]] || lu=0
  skew=$(( $(now_epoch) - lu ))
  if (( lu == 0 )); then _health_add clock warn "node.json has no last_updated_epoch"
  elif (( skew > -10 && skew < 30 )); then _health_add clock pass "node.json ${skew}s old by the manager's clock"
  else _health_add clock warn "node.json is ${skew}s off the manager's clock (stale service or clock skew)"; fi

  local result ok recorded=false
  result="$(_health_result)"; ok=$([[ "$result" == fail ]] && echo false || echo true)
  if ! is_test; then
    ensure_dir "$CLUSTER_DIR/heartbeats" 0755 "$REPO_OWNER" >/dev/null 2>&1 &&
      printf '{"hostname":%s,"received_at":%s,"result":%s,"ok":%s,"checks":%s,"last_updated_epoch":%s}\n' \
        "$(json_escape "$host")" "$(json_escape "$(now_iso)")" "$(json_escape "$result")" "$ok" "$(_health_checks_json)" "$lu" |
      write_file "$CLUSTER_DIR/heartbeats/$host.json" 0644 "$REPO_OWNER" --no-backup >/dev/null 2>&1 && recorded=true
  fi
  printf '{"ok":%s,"result":%s,"skew_s":%d,"checks":%s,"recorded":%s}' "$ok" "$(json_escape "$result")" "$skew" "$(_health_checks_json)" "$recorded"
}

# ── manager → workers ────────────────────────────────────────────────────────
# _health_worker_list — on a manager: every other swarm node (joined with its
# record in cluster/nodes) as "host|node_id|addr|minio_service|recorded|expect_json",
# plus recorded nodes the swarm does not know ("host|-|||yes|[]").
_health_worker_list() {
  local view; view="$(_stack_nodes_view)"
  local mine; mine="$(python3 -I -c 'import json,sys; print(json.dumps([sys.argv[1], sys.argv[2], *(json.loads(sys.argv[3] or "[]"))]))' \
    "$(node_name)" "$(this_hostname)" "$(node_previous_names)")"
  python3 -I -c '
import glob, json, os, sys
nodes, view, me, mine = sys.argv[1], sys.argv[2], sys.argv[3], set(json.loads(sys.argv[4]))
recs = {}
for f in sorted(glob.glob(os.path.join(view, "*.json"))):
    try:
        r = json.load(open(f))
    except (OSError, ValueError):
        continue
    if r.get("hostname"):
        recs[r["hostname"]] = r
seen = set()
for line in nodes.splitlines():
    try:
        n = json.loads(line)
    except ValueError:
        continue
    host = (n.get("Description") or {}).get("Hostname") or "?"
    seen.add(host)
    if n.get("ID") == me or host in mine:
        continue
    r = recs.get(host) or {}
    dep = r.get("deployment") or {}
    size = {d.get("label"): d.get("size_bytes") for d in dep.get("drives") or [] if isinstance(d, dict)}
    expect = [{"label": m["label"], "size_bytes": size.get(m["label"])} for m in r.get("disk_mounts") or []]
    print("%s|%s|%s|%s|%s|%s" % (host, n.get("ID"), (n.get("Status") or {}).get("Addr") or "",
          (r.get("services") or {}).get("minio") or "", "yes" if r else "no", json.dumps(expect)))
for host in sorted(recs):
    if host not in seen and host not in mine:
        print("%s|-|||yes|[]" % host)
' "$(_cluster_nodes_json)" "$view" "$(swarm_self_id)" "$mine"
}

# _health_check_worker HOST NODE_ID ADDR MINIO RECORDED EXPECT — every check of one
# worker, as the manager sees it (fills HEALTH_CHECKS).
_health_check_worker() {
  local host="$1" id="$2" addr="$3" minio="$4" recorded="$5" expect="$6"
  if [[ "$id" == - ]]; then
    _health_add swarm fail "recorded in cluster/nodes but not in the swarm (removed, or renamed without deploy.sh?)"
    return 0
  fi
  # manager → worker over the LAN: swarm's own control port on the worker.
  if [[ -z "$addr" ]]; then _health_add network warn "the swarm has no address for it"
  elif _cluster_tcp_open "$addr" 7946; then _health_add network pass "reachable at $addr (swarm port 7946)"
  else _health_add network fail "$addr does not answer on swarm port 7946 from the manager"; fi
  # drive sizes in the record are partition sizes, so allow filesystem overhead
  _heartbeat_checks "$host" "$id" "$expect" 0.12
  # manager → worker over the overlay network: the path the API really uses.
  if [[ -n "$minio" ]]; then
    local api; api="$(probe docker-api-id -- docker ps -qf "name=${STACK_NAME}_api\\." 2>/dev/null | head -n1)"
    if [[ -z "$api" ]]; then _health_add overlay warn "the api container is not running here — can't test $minio through the overlay network"
    elif probe "overlay-$minio" -- docker exec "$api" wget -q -T 5 -O /dev/null "http://$minio:9000/minio/health/live" >/dev/null 2>&1; then
      _health_add overlay pass "api -> $minio:9000 answers through the overlay network"
    else _health_add overlay fail "api can't reach $minio:9000 through the overlay network"; fi
  fi
  [[ "$recorded" == yes ]] || _health_add record warn "in the swarm, but not deployed with deploy.sh yet (run deploy there)"
  # the worker's own last heartbeat (worker → manager over ssh); informational
  local hb="$CLUSTER_DIR/heartbeats/$host.json" at res
  if [[ -n "$FIXTURES" || ! -f "$hb" ]]; then
    [[ -n "$FIXTURES" ]] || _health_add own_heartbeat warn "it has not sent one to this manager yet (run ./deploy.sh restart or update there)"
  else
    at="$(py json get --file "$hb" --key received_at --default '?' 2>/dev/null)"; res="$(py json get --file "$hb" --key result --default '?' 2>/dev/null)"
    _health_add own_heartbeat pass "last one it sent: $res at $at"
  fi
  return 0
}

# health_workers_heartbeat [TIMEOUT=90] — manager only: check the connection to
# every worker, retrying until all pass or TIMEOUT. Adds one "worker <host>" row
# per worker to the caller's HEALTH_CHECKS and records the details in node.json.
# rc 0 all fine · 1 some worker failed · 2 not a manager / no workers.
health_workers_heartbeat() {
  local timeout="${1:-90}"
  [[ "$(node_role)" == manager ]] || return 2
  manager_env_load >/dev/null 2>&1 || true
  local -a outer=("${HEALTH_CHECKS[@]+"${HEALTH_CHECKS[@]}"}") workers=()
  mapfile -t workers < <(_health_worker_list)
  if ((${#workers[@]} == 0)); then
    log_info "No worker nodes in this swarm — nothing to check from the manager."
    return 2
  fi
  log_info "Checking the connection from this manager to ${#workers[@]} worker(s)…"
  local deadline=$(( $(now_epoch) + timeout )) bad w host id addr minio rec expect
  local -a rows=() titles=() tables=(); local json
  while :; do
    bad=0; rows=(); titles=(); tables=(); json="["
    for w in "${workers[@]}"; do
      IFS='|' read -r host id addr minio rec expect <<<"$w"
      HEALTH_CHECKS=()
      _health_check_worker "$host" "$id" "$addr" "$minio" "$rec" "$expect"
      local result failed st
      result="$(_health_result)"
      [[ "$result" == fail ]] && bad=1
      failed="$(printf '%s\n' "${HEALTH_CHECKS[@]}" | awk -F'|' -v r="$result" '$2 == r && r != "pass" {printf "%s%s", s, $1; s=", "}')"
      st="$result"; [[ "$st" == fail ]] && is_test && st=warn
      rows+=("worker $host|$st|$([[ "$result" == pass ]] && echo "${#HEALTH_CHECKS[@]} checks passed" || echo "$result: $failed")")
      titles+=("Worker $host${addr:+ ($addr)}"); tables+=("$(printf '%s\n' "${HEALTH_CHECKS[@]}")")
      [[ "$json" == "[" ]] || json+=","
      json+="{\"hostname\":$(json_escape "$host"),\"addr\":$(json_escape "$addr"),\"result\":$(json_escape "$result"),\"at\":$(json_escape "$(now_iso)"),\"checks\":$(_health_checks_json)}"
    done
    json+="]"
    [[ $bad == 0 ]] && break
    is_test && break
    (( $(now_epoch) >= deadline )) && break
    sleep 5
  done
  local i; local -a t=()
  for i in "${!titles[@]}"; do
    ui_section "${titles[$i]}"
    t=("MANAGER TO WORKER|STATUS|DETAIL")
    mapfile -t -O 1 t <<<"${tables[$i]}"
    ui_table "${t[@]}"
  done
  printf '{"heartbeat":{"workers":%s,"workers_at":%s}}' "$json" "$(json_escape "$(now_iso)")" | node_json_merge deployment >/dev/null || true
  HEALTH_CHECKS=("${outer[@]+"${outer[@]}"}" "${rows[@]}")
  return "$bad"
}

# ── steps ────────────────────────────────────────────────────────────────────
# deploy_step_health — STEP (deploy/update).
deploy_step_health() {
  HEALTH_CHECKS=()
  _health_check_node_json
  _health_check_services
  _health_check_http
  _health_check_drives
  local id
  for id in "${DEFERRED_STEPS[@]+"${DEFERRED_STEPS[@]}"}"; do
    if [[ "$id" == drives ]]; then
      log_info "Re-checking the deferred drive-metrics validation now that services are up…"
      local rc=0; health_wait_disk_metrics 90 || rc=$?
      case $rc in
        0) _health_add "drive metrics" pass "the manager sees every drive (deferred check)" ;;
        3) _health_add "drive metrics" warn "still can't be checked (no stack/DB yet)" ;;
        *) _health_add "drive metrics" fail "the manager does not see every drive correctly" ;;
      esac
    fi
  done
  local hb=0
  heartbeat_run --quiet || hb=$?
  case $hb in
    0) _health_add heartbeat pass "manager $(printf '%s' "$MGR_RESPONSE" | json_get host '?') sees this node healthy" ;;
    255) _health_add heartbeat fail "manager unreachable over ssh" ;;
    *) _health_add heartbeat "$(is_test && echo warn || echo fail)" "manager reported problems (table below)" ;;
  esac
  health_workers_heartbeat 90 || true   # manager only; adds one row per worker
  _health_table || true
  [[ $hb -ne 0 && $hb -ne 255 ]] && _health_print_last
  local result; result="$(_health_result)"
  printf '{"health":{"last_check_at":%s,"result":%s,"checks":%s}}' "$(json_escape "$(now_iso)")" \
    "$(json_escape "$result")" "$(_health_checks_json)" | node_json_merge deployment >/dev/null || true
  if [[ "$result" == fail ]]; then
    STEP_FAIL_REASON="health/heartbeat checks failed — see the tables above"
    return 1
  fi
  return 0
}

restart_step_summary() {
  ui_kv "node" "$(node_json_get deployment.node.name "$(this_hostname)")"
  ui_kv "role" "$(node_json_get deployment.cluster.role "?") of \"$(node_json_get deployment.cluster.server_name "?")\""
  ui_kv "drives" "$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(", ".join(d.get("label","?") for d in json.load(sys.stdin)) or "none")')"
  ui_kv "services" "$(node_json_get deployment.stack.services '[]')"
  ui_kv "last success" "$(node_json_get deployment.last_success.op "?") at $(node_json_get deployment.last_success.at "?")"
  ui_kv "last heartbeat" "$(node_json_get deployment.heartbeat.result "never") $(node_json_get deployment.heartbeat.at "")"
  return 0
}

# restart_step_health — STEP (restart): services + drives + node.json.
restart_step_health() {
  HEALTH_CHECKS=()
  _health_check_node_json
  _health_check_services
  _health_check_http
  _health_check_drives
  _health_table || true
  local result; result="$(_health_result)"
  printf '{"health":{"last_check_at":%s,"result":%s,"checks":%s}}' "$(json_escape "$(now_iso)")" \
    "$(json_escape "$result")" "$(_health_checks_json)" | node_json_merge deployment >/dev/null || true
  [[ "$result" != fail ]] || { STEP_FAIL_REASON="health checks failed after the restart"; return 1; }
  return 0
}

# restart_step_heartbeat — STEP (restart): workers heartbeat the manager; the
# manager prints the cluster as it sees it.
restart_step_heartbeat() {
  if [[ "$(node_role)" == manager ]]; then
    local nodes; nodes="$(probe docker-node-ls -- docker node ls --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' 2>/dev/null || true)"
    local -a rows=("NODE|STATUS|AVAILABILITY|MANAGER")
    while IFS='|' read -r h s a m; do [[ -n "$h" ]] && rows+=("$h|$s|$a|${m:--}"); done <<<"$nodes"
    ui_table "${rows[@]}"
    local rc=0 wrc=0; heartbeat_run || rc=$?
    HEALTH_CHECKS=()
    health_workers_heartbeat 90 || wrc=$?
    [[ $wrc -eq 2 ]] || _health_table || true
    [[ $rc -eq 0 ]] || { STEP_FAIL_REASON="the manager's own heartbeat checks failed"; return 1; }
    if [[ $wrc -eq 1 ]] && ! is_test; then STEP_FAIL_REASON="the manager can't reach every worker properly (tables above)"; return 1; fi
    return 0
  fi
  local rc=0
  heartbeat_run || rc=$?
  case $rc in
    0) return 0 ;;
    255) STEP_FAIL_REASON="the manager is unreachable over ssh" ;;
    *) STEP_FAIL_REASON="the manager reported problems with this node (table above)" ;;
  esac
  return 1
}
