#!/usr/bin/env python3
"""apollo_node.py — Apollo SFS node helper (python3 stdlib only, >= 3.9).

Used two ways:
  * by deploy.sh for every JSON operation, so bash never parses JSON itself;
  * as the apollo-node-status background service (`daemon`), which rewrites
    node.json every 5 seconds (see apollo_metrics.py).

Always run isolated and without bytecode:  python3 -I -B apollo_node.py …
(-I drops the script directory from sys.path, so it is re-added explicitly
below — it is our own directory, never the caller's CWD.)

Subcommands (the WS0 contract — see docs/node_provisioning.md):
  json get    --file P|- --key K [--default V]
  json set    --file P --key K --value JSON [--string] [--lock P]
  json merge  --file P --owner K --patch P|- [--lock P]
  json append --file P --key K --values JSON_ARRAY [--max N] [--lock P]
  json check  --file P|-                      (rc 0 = valid JSON)
  validate    --file P [--hostname H] [--max-age S] [--text]
  net-cidr    ADDR/PREFIX                     (192.168.68.57/22 -> 192.168.68.0/22)
  daemon …    -> apollo_metrics.py  (background collector, WS1)
  collect …   -> apollo_metrics.py  (one-shot collection to stdout, WS1)
  disks …     -> apollo_disks.py    (drive discovery/classification, WS2)
  stack …     -> apollo_stack.py    (cluster/docker-stack.nodes.yml rendering, WS3)

Exit codes: 0 ok · 1 error · 2 usage · 3 missing/invalid.

Test-mode guard: when APOLLO_TEST=1 every write outside APOLLO_TEST_SANDBOX is
refused, so a --test run can never modify the device even through this helper.
"""

import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

SCHEMA_VERSION = 1
SUPPORTED_SCHEMAS = (1,)
_MISSING = object()


class UsageError(Exception):
    pass


class GuardError(Exception):
    pass


# ── test-mode guard ──────────────────────────────────────────────────────────
def guard_write(path):
    """Refuse writes outside the sandbox while a --test run is active."""
    if os.environ.get("APOLLO_TEST") != "1":
        return
    sandbox = os.environ.get("APOLLO_TEST_SANDBOX", "")
    if not sandbox:
        raise GuardError("test mode is active but APOLLO_TEST_SANDBOX is unset; refusing to write %s" % path)
    real = os.path.realpath(path)
    root = os.path.realpath(sandbox)
    if real != root and not real.startswith(root + os.sep):
        raise GuardError("test mode: refusing to write %s outside the sandbox %s" % (path, root))


# ── locking + atomic IO ──────────────────────────────────────────────────────
@contextlib.contextmanager
def file_lock(lock_path):
    """flock(2) on LOCK_PATH — interoperates with flock(1) used by bash."""
    if not lock_path:
        yield
        return
    guard_write(lock_path)
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    try:
        fd = os.open(lock_path, os.O_RDONLY | os.O_CREAT, 0o664)
    except PermissionError:
        fd = os.open(lock_path, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def read_json(path, missing_ok=False):
    if path == "-":
        data = sys.stdin.read()
        if not data.strip():
            if missing_ok:
                return {}
            raise ValueError("empty JSON input on stdin")
        return json.loads(data)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise


def atomic_write_json(path, doc, mode=0o644):
    guard_write(path)
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    with contextlib.suppress(OSError):
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


def new_document():
    return {"schema_version": SCHEMA_VERSION}


# ── dot-path helpers ─────────────────────────────────────────────────────────
def split_key(key):
    if key in ("", "."):
        return []
    return key.split(".")


def get_path(doc, key):
    cur = doc
    for seg in split_key(key):
        if isinstance(cur, dict):
            if seg not in cur:
                return _MISSING
            cur = cur[seg]
        elif isinstance(cur, list):
            try:
                idx = int(seg)
            except ValueError:
                return _MISSING
            if idx < -len(cur) or idx >= len(cur):
                return _MISSING
            cur = cur[idx]
        else:
            return _MISSING
    return cur


def set_path(doc, key, value):
    segs = split_key(key)
    if not segs:
        if not isinstance(value, dict):
            raise UsageError("the document root must be a JSON object")
        doc.clear()
        doc.update(value)
        return doc
    cur = doc
    for seg in segs[:-1]:
        if isinstance(cur, list):
            cur = cur[int(seg)]
            continue
        nxt = cur.get(seg)
        if not isinstance(nxt, (dict, list)):
            nxt = {}
            cur[seg] = nxt
        cur = nxt
    last = segs[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value
    return doc


def deep_merge(base, patch):
    """Merge PATCH into BASE: objects merge recursively, everything else replaces."""
    if not isinstance(base, dict) or not isinstance(patch, dict):
        return patch
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def render_value(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    return json.dumps(v, separators=(",", ":"))


# ── json subcommands ─────────────────────────────────────────────────────────
def cmd_json(args):
    if args.json_cmd == "check":
        try:
            read_json(args.file)
        except (ValueError, FileNotFoundError) as e:
            print("invalid JSON: %s" % e, file=sys.stderr)
            return 3
        return 0

    if args.json_cmd == "get":
        try:
            doc = read_json(args.file, missing_ok=args.default is not None)
        except FileNotFoundError:
            return 3
        except ValueError as e:
            if args.default is not None:
                sys.stdout.write(args.default)
                return 0
            print("invalid JSON: %s" % e, file=sys.stderr)
            return 3
        val = _MISSING if doc is None else get_path(doc, args.key)
        if val is _MISSING:
            if args.default is not None:
                sys.stdout.write(args.default)
                return 0
            return 3
        sys.stdout.write(render_value(val))
        return 0

    # mutating subcommands share lock + read-modify-write
    with file_lock(args.lock):
        doc = read_json(args.file, missing_ok=True)
        if doc is None:
            doc = new_document()
        if not isinstance(doc, dict):
            raise UsageError("%s does not hold a JSON object" % args.file)
        doc.setdefault("schema_version", SCHEMA_VERSION)

        if args.json_cmd == "set":
            value = args.value if args.string else json.loads(args.value)
            set_path(doc, args.key, value)
        elif args.json_cmd == "merge":
            patch = read_json(args.patch)
            if not isinstance(patch, dict):
                raise UsageError("merge patch must be a JSON object")
            current = get_path(doc, args.owner)
            if current is _MISSING or not isinstance(current, dict):
                current = {}
            merged = deep_merge(current, patch)
            if split_key(args.owner):
                set_path(doc, args.owner, merged)
            else:
                doc = merged
                doc.setdefault("schema_version", SCHEMA_VERSION)
        elif args.json_cmd == "append":
            values = json.loads(args.values)
            if not isinstance(values, list):
                raise UsageError("--values must be a JSON array")
            current = get_path(doc, args.key)
            if current is _MISSING or not isinstance(current, list):
                current = []
            current = current + values
            if args.max and len(current) > args.max:
                current = current[-args.max:]
            set_path(doc, args.key, current)
        else:
            raise UsageError("unknown json subcommand")
        atomic_write_json(args.file, doc)
    return 0


# ── validate ─────────────────────────────────────────────────────────────────
def validate_doc(doc, hostname=None, max_age=None, now=None):
    """Return (reasons, warnings). No reasons = a valid deployment record."""
    now = time.time() if now is None else now
    reasons, warnings = [], []
    if not isinstance(doc, dict):
        return ["node.json is not a JSON object"], warnings
    sv = doc.get("schema_version")
    if sv not in SUPPORTED_SCHEMAS:
        reasons.append("unsupported schema_version %r (this deploy.sh understands %s)"
                       % (sv, ", ".join(str(s) for s in SUPPORTED_SCHEMAS)))
    dep = doc.get("deployment") if isinstance(doc.get("deployment"), dict) else {}
    last = dep.get("last_success") if isinstance(dep.get("last_success"), dict) else {}
    rev = last.get("revision")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        reasons.append("no successful deploy recorded (deployment.last_success.revision < 1)")
    node = dep.get("node") if isinstance(dep.get("node"), dict) else {}
    name = node.get("name")
    if not name:
        reasons.append("deployment.node.name is missing")
    cluster = dep.get("cluster") if isinstance(dep.get("cluster"), dict) else {}
    if cluster.get("role") not in ("manager", "worker"):
        reasons.append("deployment.cluster.role is missing or invalid")
    if hostname and name and name != hostname:
        warnings.append("this host is named %r but node.json records %r (renamed outside deploy.sh?)"
                        % (hostname, name))
    run = dep.get("run") if isinstance(dep.get("run"), dict) else {}
    if run.get("state") in ("in_progress", "failed"):
        msg = "the last %s run did not finish (%s" % (run.get("op") or "deploy", run.get("state"))
        if run.get("failed_step"):
            msg += ", failed at step %s" % run["failed_step"]
        warnings.append(msg + ") — `update` can repair it")
    if max_age is not None:
        ts = doc.get("last_updated_epoch")
        if not isinstance(ts, (int, float)) or isinstance(ts, bool):
            reasons.append("metrics have never been written (no last_updated_epoch)")
        elif now - ts > max_age:
            reasons.append("metrics are stale: last_updated %ds ago (max %ds)" % (int(now - ts), max_age))
    return reasons, warnings


def cmd_validate(args):
    try:
        doc = read_json(args.file)
    except FileNotFoundError:
        reasons, warnings = ["%s does not exist" % args.file], []
    except ValueError as e:
        reasons, warnings = ["%s is not valid JSON: %s" % (args.file, e)], []
    else:
        reasons, warnings = validate_doc(doc, args.hostname, args.max_age)
    if args.text:
        for r in reasons:
            print("R %s" % r)
        for w in warnings:
            print("W %s" % w)
    else:
        print(json.dumps({"valid": not reasons, "reasons": reasons, "warnings": warnings}))
    return 0 if not reasons else 3


def cmd_net_cidr(args):
    try:
        iface = ipaddress.ip_interface(args.addr)
    except ValueError as e:
        print("invalid address: %s" % e, file=sys.stderr)
        return 2
    print(iface.network.with_prefixlen)
    return 0


# ── delegated subcommands (implemented in sibling modules) ──────────────────
def delegate(module_name, func_name, argv):
    try:
        mod = __import__(module_name)
    except ImportError as e:
        print("%s is not available: %s" % (module_name, e), file=sys.stderr)
        return 1
    fn = getattr(mod, func_name, None)
    if fn is None:
        print("%s.%s is not implemented" % (module_name, func_name), file=sys.stderr)
        return 1
    return fn(argv)


def build_parser():
    p = argparse.ArgumentParser(prog="apollo_node.py", description="Apollo SFS node helper")
    sub = p.add_subparsers(dest="cmd", required=True)

    pj = sub.add_parser("json", help="read/modify JSON documents (node.json, _remote payloads)")
    js = pj.add_subparsers(dest="json_cmd", required=True)
    g = js.add_parser("get")
    g.add_argument("--file", required=True)
    g.add_argument("--key", required=True)
    g.add_argument("--default")
    s = js.add_parser("set")
    s.add_argument("--file", required=True)
    s.add_argument("--key", required=True)
    s.add_argument("--value", required=True)
    s.add_argument("--string", action="store_true", help="treat --value as a raw string")
    s.add_argument("--lock")
    m = js.add_parser("merge")
    m.add_argument("--file", required=True)
    m.add_argument("--owner", required=True, help="dot path to merge into ('.' = root)")
    m.add_argument("--patch", required=True, help="patch file or - for stdin")
    m.add_argument("--lock")
    a = js.add_parser("append")
    a.add_argument("--file", required=True)
    a.add_argument("--key", required=True)
    a.add_argument("--values", required=True)
    a.add_argument("--max", type=int, default=0)
    a.add_argument("--lock")
    c = js.add_parser("check")
    c.add_argument("--file", required=True)

    pv = sub.add_parser("validate", help="is node.json a valid deployment record?")
    pv.add_argument("--file", required=True)
    pv.add_argument("--hostname")
    pv.add_argument("--max-age", type=int)
    pv.add_argument("--text", action="store_true", help="print 'R reason' / 'W warning' lines")

    pn = sub.add_parser("net-cidr", help="network CIDR of an interface address")
    pn.add_argument("addr")

    for name in ("daemon", "collect", "disks", "stack"):
        sp = sub.add_parser(name, add_help=False)
        sp.add_argument("rest", nargs=argparse.REMAINDER)
    return p


DELEGATED = {
    "daemon": ("apollo_metrics", "main_daemon"),
    "collect": ("apollo_metrics", "main_collect"),
    "disks": ("apollo_disks", "main"),
    "stack": ("apollo_stack", "main"),
}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    # Delegated subcommands own their argument parsing (argparse.REMAINDER
    # would swallow nothing that starts with "--"), so dispatch them first.
    if argv and argv[0] in DELEGATED:
        module, func = DELEGATED[argv[0]]
        try:
            return delegate(module, func, argv[1:])
        except GuardError as e:
            print("apollo_node: %s" % e, file=sys.stderr)
            return 1
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.cmd == "json":
            return cmd_json(args)
        if args.cmd == "validate":
            return cmd_validate(args)
        if args.cmd == "net-cidr":
            return cmd_net_cidr(args)
    except GuardError as e:
        print("apollo_node: %s" % e, file=sys.stderr)
        return 1
    except UsageError as e:
        print("apollo_node: %s" % e, file=sys.stderr)
        return 2
    except (ValueError, OSError) as e:
        print("apollo_node: %s" % e, file=sys.stderr)
        return 1
    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
