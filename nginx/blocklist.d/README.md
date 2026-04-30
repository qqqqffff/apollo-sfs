# IP Blocklist

Files in this directory are included by nginx as `deny` rules.
Create one or more `.conf` files here with entries like:

```
deny 1.2.3.4;
deny 192.168.100.0/24;
```

nginx loads all `*.conf` files in this directory on reload (`nginx -s reload`).

**On the Pi host**, symlink or copy files here to `/etc/nginx/blocklist.d/` so nginx
can read them:

```bash
sudo mkdir -p /etc/nginx/blocklist.d
sudo ln -sf /path/to/repo/nginx/blocklist.d/blocked.conf /etc/nginx/blocklist.d/blocked.conf
sudo nginx -s reload
```
