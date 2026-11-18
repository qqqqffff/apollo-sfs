# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/manager.sh — manager-level infrastructure (WS4): the .env (every value
# the stack needs), host nginx ("with the IP information": Cloudflare real-IP
# ranges, IP blocklists, upstreams, the LAN/public IPs), fail2ban, the image
# registry, arm64 emulation for builds, bind-mount directories, ownership.
# ─────────────────────────────────────────────────────────────────────────────

MANAGER_PKGS=(nginx libnginx-mod-http-geoip2 geoipupdate fail2ban qemu-user-static binfmt-support openssl)
MGR_CATALOG="$APOLLO_ROOT/scripts/deploy/env.catalog"
MGR_NGINX_SRC="$APOLLO_ROOT/nginx"
MGR_CERT="/etc/ssl/cloudflare/origin.crt"
MGR_KEY="/etc/ssl/cloudflare/origin.key"
MGR_GEOIP_DB="/var/lib/GeoIP/GeoLite2-Country.mmdb"
MGR_REGISTRY_DIR="/srv/registry"
MGR_ENV_FRESH=0

# ── .env ─────────────────────────────────────────────────────────────────────
# _mgr_env_source — the .env this run reads (fixture / sandbox render / real).
_mgr_env_source() {
  if [[ -n "$FIXTURES" ]]; then
    [[ -f "$FIXTURES/dotenv" ]] && { printf '%s' "$FIXTURES/dotenv"; return 0; }
    printf '%s' "/nonexistent/.env"; return 0
  fi
  if is_test && [[ -f "$TEST_SANDBOX/fs$DOTENV_FILE" ]]; then printf '%s' "$TEST_SANDBOX/fs$DOTENV_FILE"; return 0; fi
  printf '%s' "$DOTENV_FILE"
}

# manager_env_load — export every .env variable (bash `source`, last wins).
manager_env_load() {
  local f; f="$(_mgr_env_source)"
  [[ -f "$f" ]] || return 1
  set -a
  # shellcheck disable=SC1090
  source "$f"
  set +a
  local k v
  while IFS='|' read -r k _ kind _; do
    [[ "$kind" == secret && -n "${!k:-}" ]] && redact_add "${!k}"
  done < <(_mgr_catalog_lines)
  return 0
}

_mgr_catalog_lines() { grep -vE '^[[:space:]]*(#|$)' "$MGR_CATALOG"; }

# _mgr_env_effective — JSON {NAME: value} exactly as bash would see it, plus
# duplicates. Values are secrets: never print this, only parse it.
_mgr_env_effective() {
  local f; f="$(_mgr_env_source)"
  [[ -f "$f" ]] || { printf '{"exists":false,"values":{},"dups":{}}'; return 0; }
  local envdump
  envdump="$(env -i PATH=/usr/bin:/bin HOME=/nonexistent bash -c 'set -a; source "$1" >/dev/null 2>&1; env -0' _ "$f" | base64 -w0)"
  python3 -I -c '
import base64, json, re, sys
raw = base64.b64decode(sys.argv[1]).decode("utf-8", "replace")
vals = {}
for item in raw.split("\0"):
    if "=" in item:
        k, v = item.split("=", 1)
        vals[k] = v
names, lines = {}, open(sys.argv[2], encoding="utf-8", errors="replace").read().splitlines()
for i, l in enumerate(lines, 1):
    m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", l)
    if m: names.setdefault(m.group(1), []).append(i)
keep = {k: vals.get(k, "") for k in names}
print(json.dumps({"exists": True, "values": keep, "dups": {k: v for k, v in names.items() if len(v) > 1}}))
' "$envdump" "$f"
}

_mgr_gen() {   # _mgr_gen base64:N|hex:N
  case "$1" in
    base64:*) openssl rand -base64 "${1#base64:}" | tr -d '\n' ;;
    hex:*) openssl rand -hex "${1#hex:}" ;;
    *) return 1 ;;
  esac
}

# _mgr_validate VALIDATOR VALUE — rc 0 ok; prints why on stderr.
_mgr_validate() {
  local v="$2"
  case "$1" in
    -|"") return 0 ;;
    nonempty) [[ -n "$v" ]] || { log_warn "must not be empty"; return 1; } ;;
    minlen8|minlen16|minlen32) local n="${1#minlen}"; (( ${#v} >= n )) || { log_warn "must be at least $n characters"; return 1; } ;;
    b64len32)
      local len; len="$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)"
      [[ "$len" == 32 ]] || { log_warn "must be base64 of exactly 32 bytes (openssl rand -base64 32) — this decodes to $len bytes"; return 1; } ;;
    https_url) [[ "$v" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]] || { log_warn "must be an https:// URL"; return 1; } ;;
    domain) [[ "$v" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || { log_warn "must be a domain like example.com"; return 1; } ;;
    email) [[ "$v" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { log_warn "must be an e-mail address"; return 1; } ;;
    int) [[ "$v" =~ ^[0-9]+$ ]] || { log_warn "must be a whole number"; return 1; } ;;
    number) [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { log_warn "must be a number"; return 1; } ;;
    bool) [[ "$v" == true || "$v" == false ]] || { log_warn "must be true or false"; return 1; } ;;
    mem_size) [[ "$v" =~ ^[0-9]+(\.[0-9]+)?[bBkKmMgGtT][bB]?$ ]] || { log_warn "needs a unit, e.g. 16G (a bare number means BYTES to Docker)"; return 1; } ;;
    bucket) [[ "$v" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { log_warn "must be a valid S3 bucket name"; return 1; } ;;
    ident) [[ "$v" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || { log_warn "letters, digits and _ only"; return 1; } ;;
    dbname) [[ "$v" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ ]] || { log_warn "letters, digits, '_', '.' and '-' only"; return 1; } ;;
    tz) [[ "$v" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$ ]] || { log_warn "must be an IANA zone like America/New_York"; return 1; } ;;
    hostport) [[ "$v" =~ ^[A-Za-z0-9.-]+:[0-9]{2,5}$ ]] || { log_warn "must be HOST:PORT"; return 1; } ;;
  esac
  return 0
}

# One wrapper per validator so `ask --validate FN` gets a plain function name.
for _mgr_v in dbname nonempty b64len32 minlen8 minlen16 minlen32 https_url domain email int number bool mem_size bucket ident tz hostport; do
  eval "_mgr_v_${_mgr_v}() { _mgr_validate ${_mgr_v} \"\$1\"; }"
done
unset _mgr_v

_mgr_quote() {   # single-quote for bash `source` (round-trips any value)
  local v="$1"; printf "'%s'" "${v//\'/\'\\\'\'}"
}

# manager_env_missing_required — names of required variables that are empty.
manager_env_missing_required() {
  local eff; eff="$(_mgr_env_effective)"
  local name req
  while IFS='|' read -r name req _; do
    [[ "$req" == required ]] || continue
    [[ -n "$(printf '%s' "$eff" | json_get "values.$name" "")" ]] || printf '%s\n' "$name"
  done < <(_mgr_catalog_lines)
}

# _mgr_env_step — prompt for missing values, report duplicates, fix perms.
_mgr_env_step() {
  ui_section ".env (secrets and settings for every service)"
  local eff exists
  eff="$(_mgr_env_effective)"; exists="$(printf '%s' "$eff" | json_get exists false)"
  local name req kind gen val def desc v domain=""
  local app; app="$(printf '%s' "$eff" | json_get values.APP_BASE_URL "")"
  [[ -n "$app" ]] && { domain="${app#https://}"; domain="${domain%%/*}"; }
  local -a add=()
  if [[ "$exists" != true ]]; then
    MGR_ENV_FRESH=1
    log_info "No .env yet — answering a few questions creates it (secrets can be generated with 'g')."
    ask domain "Public domain of this server (e.g. apollo-sfs.com)" --validate _mgr_v_domain
  fi
  local missing=0
  while IFS='|' read -r name req kind gen val def desc; do
    [[ -n "$name" ]] || continue
    local cur; cur="$(printf '%s' "$eff" | json_get "values.$name" "")"
    [[ "$kind" == secret && -n "$cur" ]] && redact_add "$cur"
    if [[ -n "$cur" ]]; then
      if ! _mgr_validate "$val" "$cur" 2>/dev/null; then
        log_warn "$name has an unusual value (kept as is): $(_mgr_validate "$val" "$cur" 2>&1 | sed 's/^.*⚠ //' | head -n1)"
      fi
      continue
    fi
    [[ "$req" == required || $MGR_ENV_FRESH == 1 ]] || continue
    missing=$((missing + 1))
    local d=""
    case "$def" in
      fixed:*) v="${def#fixed:}"; log_detail "$name=$v (fixed)"; add+=("$name=$v"); continue ;;
      default:*) d="${def#default:}" ;;
      domain:*) [[ -n "$domain" ]] && { d="${def#domain:}"; d="${d//\{D\}/$domain}"; } ;;
    esac
    local -a aopts=(--hint "$desc")
    [[ -n "$d" ]] && aopts+=(--default "$d")
    [[ "$kind" == secret ]] && aopts+=(--secret)
    [[ "$gen" != none ]] && aopts+=(--generate "_mgr_gen_$name")
    [[ "$val" != - ]] && aopts+=(--validate "_mgr_v_$val")
    [[ "$req" == optional ]] && aopts+=(--allow-empty)
    eval "_mgr_gen_$name() { _mgr_gen '$gen'; }"
    ask v "$name" "${aopts[@]}"
    [[ -n "$v" ]] && add+=("$name=$v")
  done < <(_mgr_catalog_lines)

  # Duplicated keys: bash uses the LAST one; only clean up when the running
  # api has exactly that value (compared by hash — values are never printed).
  local dups; dups="$(printf '%s' "$eff" | json_get dups '{}')"
  local -a cleanup=()
  if [[ "$dups" != "{}" ]]; then
    local running; running="$(probe docker-api-env -- docker service inspect "${STACK_NAME}_api" --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' 2>/dev/null || echo '[]')"
    local k lines
    while IFS='|' read -r k lines; do
      [[ -n "$k" ]] || continue
      log_warn "$k is defined $(( $(tr -cd ',' <<<"$lines" | wc -c) + 1 )) times in .env (lines $lines) — the LAST one is in effect."
      local same; same="$(python3 -I -c '
import hashlib, json, sys
eff = json.loads(sys.argv[1])["values"].get(sys.argv[2], "")
env = dict(e.split("=", 1) for e in json.loads(sys.argv[3] or "[]") if "=" in e)
print("same" if sys.argv[2] in env and hashlib.sha256(env[sys.argv[2]].encode()).hexdigest() == hashlib.sha256(eff.encode()).hexdigest() else "differs")' "$eff" "$k" "$running")"
      if [[ "$same" == same ]]; then
        ask_yn "The running api uses that last value. Comment out the earlier duplicate(s) of $k?" y && cleanup+=("$k")
      else
        alert_ack warn "env-dup-$k" "$k is duplicated and the running api does not use the effective value" \
          "Nothing was changed. Check which value the service should use, remove the other line by hand,
then run ./deploy.sh update. (Values are never printed.)"
      fi
    done < <(printf '%s' "$dups" | python3 -I -c 'import json,sys; [print("%s|%s" % (k, ",".join(map(str, v)))) for k, v in json.load(sys.stdin).items()]')
  fi

  local reg
  reg="$(state_get lan_ip ""):5000"
  [[ -n "$(printf '%s' "$eff" | json_get values.REGISTRY "")" || -z "$(state_get lan_ip "")" ]] || add+=("REGISTRY=$reg")

  if ((${#add[@]} == 0 && ${#cleanup[@]} == 0)); then
    log_ok ".env has every required value."
  else
    local src out
    src="$(_mgr_env_source)"
    out="$( { [[ -f "$src" ]] && cat "$src"; true; } | python3 -I -c '
import re, sys
cleanup = set(sys.argv[1].split(",")) - {""}
lines = sys.stdin.read().splitlines()
last = {}
for i, l in enumerate(lines):
    m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", l)
    if m: last[m.group(1)] = i
out = []
for i, l in enumerate(lines):
    m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", l)
    if m and m.group(1) in cleanup and last[m.group(1)] != i:
        out.append("# duplicate removed by deploy.sh (later definition wins): " + m.group(1) + "=…")
    else:
        out.append(l)
print("\n".join(out))' "$(IFS=,; echo "${cleanup[*]+"${cleanup[*]}"}")")"
    if ((${#add[@]})); then
      out+=$'\n'"# --- added by deploy.sh $(date +%F) ---"
      local kv
      for kv in "${add[@]}"; do out+=$'\n'"${kv%%=*}=$(_mgr_quote "${kv#*=}")"; done
    fi
    printf '%s\n' "$out" | write_file "$DOTENV_FILE" 0600 "$REPO_OWNER:$REPO_GROUP" --env || return 1
    log_ok ".env updated (${#add[@]} added, ${#cleanup[@]} duplicate(s) cleaned)."
  fi
  return 0
}

# ── nginx ────────────────────────────────────────────────────────────────────
_mgr_nginx_version_old() {   # rc 0 when nginx < 1.25.1 (no `http2 on;`)
  local v; v="$(probe nginx-version -- nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p' | head -n1)"
  [[ -n "$v" ]] || return 1
  python3 -I -c 'import sys; v=tuple(int(x) for x in sys.argv[1].split(".")[:3]); sys.exit(0 if v < (1,25,1) else 1)' "$v"
}

# _mgr_nginx_transform FILE DOMAIN UPSTREAM OLD_HTTP2(0|1) IPV6(0|1)
_mgr_nginx_transform() {
  python3 -I -c '
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
domain, upstream, old_http2, ipv6 = sys.argv[2], sys.argv[3], sys.argv[4] == "1", sys.argv[5] == "1"
if domain and domain != "apollo-sfs.com":
    text = text.replace("apollo-sfs.com", domain)
if upstream and upstream != "127.0.0.1":
    text = re.sub(r"(proxy_pass\s+https?://)127\.0\.0\.1(:\d+)", lambda m: m.group(1) + upstream + m.group(2), text)
if old_http2:
    # nginx < 1.25.1 has no `http2` directive: use `listen … http2` instead.
    text = re.sub(r"^\s*http2\s+on;\s*\n", "", text, flags=re.M)
    text = re.sub(r"^(\s*listen\s+(?:\[::\]:)?443\s+ssl)(\s*;)", r"\1 http2\2", text, flags=re.M)
if not ipv6:
    text = re.sub(r"^\s*listen\s+\[::\]:\d+[^;]*;\s*\n", "", text, flags=re.M)
sys.stdout.write(text)' "$@"
}

# _mgr_nginx_render_all — write the rendered nginx files; sets MGR_NGINX_CHANGED.
MGR_NGINX_CHANGED=0
_mgr_nginx_render_all() {
  local domain="$1" upstream="$2" old="$3" v6="$4" f rel
  MGR_NGINX_CHANGED=0
  _mgr_nginx_transform "$MGR_NGINX_SRC/nginx.conf" "$domain" "$upstream" "$old" "$v6" | write_file /etc/nginx/nginx.conf 0644 root:root || return 1
  [[ $WRITE_CHANGED == 1 ]] && MGR_NGINX_CHANGED=1
  _mgr_nginx_transform "$MGR_NGINX_SRC/conf.d/apollo-sfs.conf" "$domain" "$upstream" "$old" "$v6" | write_file /etc/nginx/conf.d/apollo-sfs.conf 0644 root:root || return 1
  [[ $WRITE_CHANGED == 1 ]] && MGR_NGINX_CHANGED=1
  write_file /etc/nginx/blocklist.d/blocked.conf 0644 root:root <"$MGR_NGINX_SRC/blocklist.d/blocked.conf" || return 1
  [[ $WRITE_CHANGED == 1 ]] && MGR_NGINX_CHANGED=1
  if ! probe nginx-autoblock-exists -- test -f /etc/nginx/blocklist.d/auto-blocked.conf >/dev/null 2>&1; then
    printf '' | write_file /etc/nginx/blocklist.d/auto-blocked.conf 0644 root:root || return 1
    MGR_NGINX_CHANGED=1
  fi
  # The refresh timer owns this file once installed; only seed it when absent.
  if ! probe nginx-cfip-exists -- test -f /etc/nginx/conf.d/cloudflare-real-ip.conf >/dev/null 2>&1; then
    write_file /etc/nginx/conf.d/cloudflare-real-ip.conf 0644 root:root <"$MGR_NGINX_SRC/conf.d/cloudflare-real-ip.conf" || return 1
    MGR_NGINX_CHANGED=1
  fi
  while IFS= read -r f; do
    rel="${f#"$MGR_NGINX_SRC/well-known/"}"
    write_file "/etc/nginx/well-known/$rel" 0644 root:root <"$f" || return 1
    [[ $WRITE_CHANGED == 1 ]] && MGR_NGINX_CHANGED=1
  done < <(find "$MGR_NGINX_SRC/well-known" -type f | sort)
  return 0
}

_mgr_tls_step() {
  local domain="$1"
  if probe tls-cert-exists -- test -f "$MGR_CERT" >/dev/null 2>&1 && probe tls-key-exists -- test -f "$MGR_KEY" >/dev/null 2>&1; then
    local san; san="$(probe tls-cert-san -- openssl x509 -in "$MGR_CERT" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' | tr ',' '\n' | sed -n 's/^DNS://p' | tr '\n' ' ')"
    local h miss=""
    for h in "$domain" "www.$domain" "auth.$domain"; do
      [[ " $san " == *" $h "* || " $san " == *" *.${h#*.} "* ]] || miss+="$h "
    done
    [[ -z "$miss" ]] || log_warn "The origin certificate does not cover: $miss(SANs: $san)"
    local cm km
    cm="$(probe tls-cert-pub -- openssl x509 -in "$MGR_CERT" -noout -pubkey 2>/dev/null | sha256sum | cut -c1-16)"
    km="$(probe tls-key-pub -- openssl pkey -in "$MGR_KEY" -pubout 2>/dev/null | sha256sum | cut -c1-16)"
    [[ -n "$cm" && "$cm" == "$km" ]] || log_warn "The origin key does not match the certificate."
    local end; end="$(probe tls-cert-end -- openssl x509 -in "$MGR_CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
    log_ok "Origin certificate present${end:+ (valid until $end)}."
    return 0
  fi
  log_warn "The Cloudflare origin certificate is missing ($MGR_CERT / $MGR_KEY)."
  log_info "  Create one in Cloudflare → SSL/TLS → Origin Server (cover $domain, www.$domain, auth.$domain)."
  local crt key
  ask crt "Path to the origin certificate PEM (empty = skip for now)" --allow-empty
  if [[ -z "$crt" ]]; then
    alert_ack warn tls-missing "nginx can't serve HTTPS without the origin certificate" \
      "Install $MGR_CERT and $MGR_KEY (key mode 0600), then run ./deploy.sh update."
    return 1
  fi
  ask key "Path to the private key PEM"
  [[ -r "$crt" && -r "$key" ]] || { log_error "cannot read $crt / $key"; return 1; }
  ensure_dir /etc/ssl/cloudflare 0755 root:root || return 1
  write_file "$MGR_CERT" 0644 root:root <"$crt" || return 1
  write_file "$MGR_KEY" 0600 root:root --secret <"$key" || return 1
  return 0
}

_mgr_geoip_step() {
  if probe geoip-db-exists -- test -f "$MGR_GEOIP_DB" >/dev/null 2>&1; then
    log_ok "GeoLite2 database present."
    return 0
  fi
  log_warn "$MGR_GEOIP_DB is missing — nginx's geoip2 module refuses to start without it."
  log_info "  A free MaxMind account provides it: https://www.maxmind.com/en/geolite2/signup"
  local acct lic
  ask acct "MaxMind account id (empty = skip for now)" --allow-empty --validate _mgr_v_int
  if [[ -z "$acct" ]]; then
    alert_ack warn geoip-missing "GeoIP database missing" \
      "Place GeoLite2-Country.mmdb in /var/lib/GeoIP (or configure /etc/GeoIP.conf and run geoipupdate),
then run ./deploy.sh update. nginx -t fails until then."
    return 1
  fi
  ask lic "MaxMind license key" --secret
  printf 'AccountID %s\nLicenseKey %s\nEditionIDs GeoLite2-Country\n' "$acct" "$lic" |
    write_file /etc/GeoIP.conf 0600 root:root --secret || return 1
  ensure_dir /var/lib/GeoIP 0755 root:root || return 1
  run -- geoipupdate || { log_error "geoipupdate failed"; return 1; }
  printf '[Unit]\nDescription=Refresh the MaxMind GeoLite2 database (apollo-sfs)\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/geoipupdate\nExecStartPost=-/usr/sbin/nginx -s reload\n' |
    write_file /etc/systemd/system/apollo-geoipupdate.service 0644 root:root || return 1
  printf '[Unit]\nDescription=Weekly GeoLite2 refresh (apollo-sfs)\n\n[Timer]\nOnCalendar=weekly\nPersistent=true\nRandomizedDelaySec=1h\n\n[Install]\nWantedBy=timers.target\n' |
    write_file /etc/systemd/system/apollo-geoipupdate.timer 0644 root:root || return 1
  run -- systemctl daemon-reload && run -- systemctl enable --now apollo-geoipupdate.timer
  return 0
}

# _mgr_nginx_step — render + validate + reload; show the IP information.
_mgr_nginx_step() {
  ui_section "nginx (TLS, Cloudflare real IPs, blocklists, upstreams)"
  manager_env_load >/dev/null 2>&1 || true
  local domain="${APP_BASE_URL:-https://apollo-sfs.com}"; domain="${domain#https://}"; domain="${domain%%/*}"
  local upstream="${NGINX_UPSTREAM_HOST:-127.0.0.1}" old=0 v6=1
  _mgr_nginx_version_old && old=1
  [[ -s /proc/net/if_inet6 ]] || v6=0
  ui_kv "domain" "$domain (+ www., auth.)"
  ui_kv "upstreams" "$upstream:3000 (frontend), :8080 (api), :8180 (keycloak)"
  [[ $old == 1 ]] && log_info "nginx is older than 1.25.1 — rendering 'listen 443 ssl http2' instead of 'http2 on;'."
  [[ $v6 == 0 ]] && log_info "No IPv6 on this host — dropping the [::] listeners."
  local ok=1
  _mgr_tls_step "$domain" || ok=0
  _mgr_geoip_step || ok=0
  _mgr_nginx_render_all "$domain" "$upstream" "$old" "$v6" || return 1
  # Cloudflare's real-IP ranges: refresh now, keep the weekly timer.
  if probe cfip-unit-present -- systemctl cat cf-ip-refresh.service >/dev/null 2>&1; then
    run -- systemctl start cf-ip-refresh.service || log_warn "Cloudflare IP refresh failed (the existing list stays)"
    probe cfip-timer-enabled -- systemctl is-enabled cf-ip-refresh.timer >/dev/null 2>&1 ||
      run -- systemctl enable --now cf-ip-refresh.timer
  else
    log_info "The Cloudflare IP refresh timer is installed by fail2ban/install.sh (next)."
  fi
  if [[ $ok == 1 ]]; then
    if ! run -- nginx -t; then
      log_error "nginx -t rejected the configuration — restoring the previous files."
      local f
      for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/apollo-sfs.conf /etc/nginx/blocklist.d/blocked.conf; do
        [[ -f "$BACKUP_DIR$f" ]] && run -- cp -a "$BACKUP_DIR$f" "$f"
      done
      STEP_FAIL_REASON="nginx -t failed (see above)"
      return 1
    fi
    if probe nginx-active -- systemctl is-active nginx >/dev/null 2>&1; then
      [[ $MGR_NGINX_CHANGED == 1 ]] && run -- systemctl reload nginx
    else
      run -- systemctl enable --now nginx || return 1
    fi
  else
    log_warn "nginx was not reloaded until the certificate/GeoIP prerequisites are in place."
  fi
  local lan pub prev
  lan="$(state_get lan_ip "")"
  pub="$(probe public-ip -- curl -fsS -m 5 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
  prev="$(node_json_get deployment.cluster.manager_lan_ip "" 2>/dev/null)"
  ui_kv "LAN IP" "${lan:-?}"
  ui_kv "public IP" "${pub:-unknown}"
  if [[ "$(state_get fresh_cluster 0)" == 1 || "$(state_get handover 0)" == 1 || ( -n "$prev" && "$prev" != "$lan" ) ]]; then
    alert_ack info router-forward "Point the router at this manager" \
      "Forward TCP 80 and 443 from the router to $lan (this node).
Cloudflare DNS for $domain is kept on ${pub:-the public IP} by the DDNS service."
  fi
  printf '{"cluster":{"manager_lan_ip":%s}}' "$(json_escape "$lan")" | node_json_merge deployment >/dev/null || true
  return 0
}

# ── fail2ban / registry / binfmt / dirs / ownership / ufw ───────────────────
_mgr_fail2ban_step() {
  if probe fail2ban-jail -- fail2ban-client status nginx-api-scan >/dev/null 2>&1; then
    log_ok "fail2ban jail nginx-api-scan is active."
    return 0
  fi
  log_info "Installing the fail2ban jail (fail2ban/install.sh)…"
  run -- bash "$APOLLO_ROOT/fail2ban/install.sh" || { log_warn "fail2ban/install.sh failed — API scan bans are not active"; return 0; }
  return 0
}

# manager_ensure_registry — the image registry container on /srv/registry.
manager_ensure_registry() {
  # During a takeover the registry data is copied in the maintenance window;
  # starting an empty registry here first would only be overwritten.
  if [[ "$(state_get handover 0)" == 1 && "$(state_get handover_phase "")" != switching ]]; then
    log_info "Image registry: started at the switchover (its data is copied from the old manager first)."
    return 0
  fi
  local st; st="$(probe registry-running -- docker inspect -f '{{.State.Running}}' registry 2>/dev/null || echo missing)"
  case "$st" in
    true) log_ok "Image registry is running." ;;
    false) run -- docker start registry >/dev/null || return 1 ;;
    *)
      ensure_dir "$MGR_REGISTRY_DIR" 0755 root:root || return 1
      run -- docker run -d --name registry --restart=always -p 5000:5000 -v "$MGR_REGISTRY_DIR:/var/lib/registry" registry:2 >/dev/null || return 1 ;;
  esac
  local addr prev
  addr="$(state_get lan_ip "$(node_json_get deployment.node.ip "")"):5000"
  prev="$(node_json_get deployment.cluster.registry "" 2>/dev/null)"
  if [[ -n "$prev" && "$prev" != "$addr" && "$addr" != ":5000" ]]; then
    log_info "Registry address changed ($prev → $addr) — the buildx builder pins the old one; recreating it on the next release."
    run -- docker buildx rm apollo-builder >/dev/null 2>&1 || true
  fi
  [[ "$addr" != ":5000" ]] && printf '{"cluster":{"registry":%s}}' "$(json_escape "$addr")" | node_json_merge deployment >/dev/null
  return 0
}

# manager_registry_addr — registry HOST:PORT (node.json → .env → default).
manager_registry_addr() {
  local r; r="$(node_json_get deployment.cluster.registry "" 2>/dev/null)"
  [[ -n "$r" ]] || r="$(_mgr_env_effective | json_get values.REGISTRY "" 2>/dev/null)"
  printf '%s' "${r:-192.168.68.57:5000}"
}

# manager_ensure_binfmt — arm64 emulation for multi-arch image builds.
manager_ensure_binfmt() {
  if probe binfmt-aarch64 -- test -e /proc/sys/fs/binfmt_misc/qemu-aarch64 >/dev/null 2>&1; then return 0; fi
  if _system_pkg_installed qemu-user-static && probe binfmt-unit -- systemctl cat systemd-binfmt.service >/dev/null 2>&1; then
    run -- systemctl restart systemd-binfmt.service && return 0
  fi
  log_info "Registering arm64 emulation for buildx (tonistiigi/binfmt)…"
  run -- docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
}

_mgr_bind_dirs() {
  local p
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    case "$p" in
      /var/run/docker.sock|"$APOLLO_ROOT"/keycloak/*|"$APOLLO_ROOT"/db|/srv/minio/*) continue ;;
    esac
    probe "bind-source-$(probe_key "${p/#$APOLLO_ROOT/repo}")" -- test -e "$p" >/dev/null 2>&1 || ensure_dir "$p" 0755 root:root || return 1
  done < <(APOLLO_DISK_STATS_SOURCE="${APOLLO_DISK_STATS_SOURCE:-/srv/minio/hdd-01}" _stack_manager_bind_sources)
  return 0
}

_mgr_normalize_ownership() {
  [[ "$REPO_OWNER" != root ]] || return 0
  local f
  for f in "$DOTENV_FILE" "$STACK_FILE"; do
    [[ -e "$f" ]] || continue
    [[ "$(stat -c %U "$f")" == "$REPO_OWNER" ]] || run -- chown "$REPO_OWNER:$REPO_GROUP" "$f"
  done
  [[ -e "$DOTENV_FILE" && "$(stat -c %a "$DOTENV_FILE")" != 600 ]] && run -- chmod 600 "$DOTENV_FILE"
  [[ -d "$CLUSTER_DIR" ]] && run -- chown -R "$REPO_OWNER:$REPO_GROUP" "$CLUSTER_DIR"
  return 0
}

_mgr_ufw_offer() {
  local st; st="$(probe ufw-status -- ufw status 2>/dev/null | head -n1)"
  [[ "$st" == *"Status: active"* ]] || return 0
  local cidr; cidr="$(state_get lan_cidr "")"
  log_info "ufw is active. Rules this manager needs: SSH, 80/443, swarm 2377/7946/4789 and the registry 5000 from $cidr."
  ask_yn "Add those allow rules?" y || return 0
  run -- ufw allow OpenSSH >/dev/null
  run -- ufw allow 80/tcp >/dev/null && run -- ufw allow 443/tcp >/dev/null
  if [[ -n "$cidr" ]]; then
    run -- ufw allow from "$cidr" to any port 2377 proto tcp >/dev/null
    run -- ufw allow from "$cidr" to any port 7946 >/dev/null
    run -- ufw allow from "$cidr" to any port 4789 proto udp >/dev/null
    run -- ufw allow from "$cidr" to any port 5000 proto tcp >/dev/null
  fi
  return 0
}

# deploy_step_manager — STEP (manager only; deploy + update).
deploy_step_manager() {
  local -a missing=()
  mapfile -t missing < <(system_missing_packages "${MANAGER_PKGS[@]}")
  if ((${#missing[@]})); then
    if [[ " ${missing[*]} " == *" geoipupdate "* ]] && ! probe apt-geoipupdate -- apt-cache show geoipupdate >/dev/null 2>&1; then
      log_warn "geoipupdate is in Debian's 'contrib' component, which is not enabled here."
      if ask_yn "Enable contrib (adds 'contrib' to the Debian sources)?" y; then
        run -- sed -i -E 's/^(Components: .*main)$/\1 contrib/; s/^(deb .* main)$/\1 contrib/' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list || true
      fi
    fi
    system_install_packages "${missing[@]}" || return 1
  fi
  _mgr_env_step || return 1
  _mgr_nginx_step || return 1
  _mgr_fail2ban_step
  manager_ensure_registry || log_warn "the image registry is not running"
  manager_ensure_binfmt || log_warn "arm64 emulation is not registered (arm64 builds will fail)"
  _mgr_bind_dirs || return 1
  _mgr_normalize_ownership
  _mgr_ufw_offer
  local h; h="$( { cat "$MGR_NGINX_SRC/nginx.conf" "$MGR_NGINX_SRC/conf.d/apollo-sfs.conf"; } | sha256sum | cut -c1-64)"
  printf '{"components":{"nginx":{"sha256":%s,"checked_at":%s},"env":{"checked_at":%s},"fail2ban":{"checked_at":%s},"registry":{"checked_at":%s}}}' \
    "$(json_escape "$h")" "$(json_escape "$(now_iso)")" "$(json_escape "$(now_iso)")" "$(json_escape "$(now_iso)")" \
    "$(json_escape "$(now_iso)")" | node_json_merge deployment >/dev/null || true
  return 0
}

# manager_fresh_extras — after the first stack deploy of a brand-new server.
manager_fresh_extras() {
  manager_env_load >/dev/null 2>&1 || true
  if ! is_test; then
    log_info "Waiting for the app database…"
    local i cid h
    for i in $(seq 1 60); do
      cid="$(docker ps -qf "name=${STACK_NAME}_db-app" | head -n1)"
      h="$([[ -n "$cid" ]] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)"
      [[ "$h" == healthy ]] && break
      sleep 3
    done
    [[ "$h" == healthy ]] || { log_error "db-app did not become healthy"; return 1; }
  fi
  run -- env STACK_NAME="$STACK_NAME" "$APOLLO_ROOT/db/apply-migrations.sh" || log_warn "applying migrations failed — run ./db/apply-migrations.sh"
  _mgr_keycloak_secret_sync || log_warn "the Keycloak client secret could not be synced — see docs/node_provisioning.md"
  alert_ack info fresh-server "New server — two things to check" \
    "1. The API's default storage endpoint is the fast-tier 'minio' service: add a node with NVMe/SSD
   drives and the blob storage role (or uploads to the default tier fail).
2. Sign in as an admin and run Admin → Metrics → Infrastructure → Sync once, so the app registers
   the storage tiers and their drives."
  return 0
}

# _mgr_keycloak_secret_sync — a fresh realm import leaves the API client's
# secret as the placeholder from realm.json; set it to the .env value.
_mgr_keycloak_secret_sync() {
  [[ -n "${KEYCLOAK_CLIENT_SECRET:-}" ]] || return 1
  local kc; kc="$(probe docker-keycloak-id -- docker ps -qf "name=${STACK_NAME}_keycloak" 2>/dev/null | head -n1)"
  [[ -n "$kc" ]] || { is_test && return 0; return 1; }
  local realm="${KEYCLOAK_REALM:-apollo-sfs-realm}" client="${KEYCLOAK_CLIENT_ID:-apollo-sfs-api}"
  redact_add "$KEYCLOAK_ADMIN_PASSWORD" "$KEYCLOAK_CLIENT_SECRET"
  run --redact "$KEYCLOAK_ADMIN_PASSWORD" -- docker exec "$kc" /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8180 --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null || return 1
  local id cur
  id="$(probe docker-keycloak-client-id -- docker exec "$kc" /opt/keycloak/bin/kcadm.sh get clients -r "$realm" -q "clientId=$client" --fields id --format csv --noquotes 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || { is_test && return 0; return 1; }
  cur="$(probe docker-keycloak-client-secret -- docker exec "$kc" /opt/keycloak/bin/kcadm.sh get "clients/$id/client-secret" -r "$realm" 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("value",""))' 2>/dev/null || true)"
  [[ -n "$cur" ]] && redact_add "$cur"
  if [[ "$cur" == "$KEYCLOAK_CLIENT_SECRET" ]]; then log_ok "Keycloak client secret matches .env."; return 0; fi
  log_info "Setting the $client client secret in Keycloak to the .env value…"
  run --redact "$KEYCLOAK_CLIENT_SECRET" -- docker exec "$kc" /opt/keycloak/bin/kcadm.sh update "clients/$id" -r "$realm" \
    -s "secret=$KEYCLOAK_CLIENT_SECRET" >/dev/null || return 1
  return 0
}

# drift_manager — update drift lines.
drift_manager() {
  [[ "$(node_role)" == manager ]] || return 0
  local miss; miss="$(manager_env_missing_required | paste -sd' ' -)"
  if [[ -n "$miss" ]]; then echo "crit|manager|.env is missing: $miss"; else echo "ok|manager|.env has every required value"; fi
  local dups; dups="$(_mgr_env_effective | json_get dups '{}')"
  [[ "$dups" == "{}" ]] || echo "warn|manager|.env defines some keys more than once: $(printf '%s' "$dups" | python3 -I -c 'import json,sys; print(" ".join(json.load(sys.stdin)))')"
  [[ -f "$DOTENV_FILE" && "$(stat -c %a "$DOTENV_FILE")" != 600 ]] && echo "warn|manager|.env is mode $(stat -c %a "$DOTENV_FILE") (secrets readable by other users)"
  manager_env_load >/dev/null 2>&1 || true
  local domain="${APP_BASE_URL:-https://apollo-sfs.com}"; domain="${domain#https://}"; domain="${domain%%/*}"
  local old=0 v6=1; _mgr_nginx_version_old && old=1; [[ -s /proc/net/if_inet6 ]] || v6=0
  if [[ "$(_mgr_nginx_transform "$MGR_NGINX_SRC/conf.d/apollo-sfs.conf" "$domain" "${NGINX_UPSTREAM_HOST:-127.0.0.1}" "$old" "$v6")" != "$(cat /etc/nginx/conf.d/apollo-sfs.conf 2>/dev/null)" ]]; then
    echo "warn|manager|installed nginx site config differs from the repo"
  fi
  probe fail2ban-jail -- fail2ban-client status nginx-api-scan >/dev/null 2>&1 || echo "warn|manager|fail2ban jail nginx-api-scan is not active"
  [[ "$(probe registry-running -- docker inspect -f '{{.State.Running}}' registry 2>/dev/null)" == true ]] || echo "warn|manager|registry container not running"
  if [[ -f "$MGR_GEOIP_DB" ]] && (( $(now_epoch) - $(stat -c %Y "$MGR_GEOIP_DB") > 45 * 86400 )); then echo "warn|manager|GeoLite2 database is over 45 days old"; fi
  local end; end="$(openssl x509 -in "$MGR_CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -n "$end" ]] && (( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(now_epoch) < 30 * 86400 )); then echo "warn|manager|origin certificate expires $end"; fi
  return 0
}
