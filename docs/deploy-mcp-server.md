# Deploy the MCP server (public `/mcp` endpoint)

Audience: whoever has shell access to the VerityDAM host. Takes about 15 minutes.

The settings page **Cài đặt → API & MCP Server** shows two live checks:
**Server** (app → `verity-dam-mcp:8000/health`) and **Endpoint public**
(`https://<domain>/mcp` must answer `401` with the `VerityDAM MCP` realm).
Both are green only after every step below.

## What changes

| Item | Change |
|---|---|
| Migration `0052_mcp_governance.sql` | Revokes the seed key committed in `0050`, adds `expires_at`/`rotated_from_id` to `mcp_api_keys`, `api_key_id` to `mcp_tool_call_log`, new table `mcp_tool_settings`. Additive only. |
| New service `verity-dam-mcp` | Python MCP server, Streamable HTTP on `:8000`, path `/mcp`, published on host `127.0.0.1:8000`. |
| App env | `VERITY_MCP_INTERNAL_URL` (default `http://verity-dam-mcp:8000`); `docker-compose.yml` now also passes `VERITY_INTERNAL_SERVICE_KEY` to the app (needed by the `media_search` tool). |
| Cloudflare Tunnel | One extra ingress rule: `<domain>` + path `^/mcp` → `http://127.0.0.1:8000`. |

**Order matters:** migrate before starting the new code. The new MCP auth query
reads `mcp_api_keys.expires_at`; without migration 0052 every MCP request fails.

## Steps

Pick the compose file the host actually runs (`docker compose ls`; the current
host uses `docker-compose.yml` with `.env`). Examples use:

```bash
cd /opt/verity-dam
C="docker compose -f docker-compose.yml --env-file .env --profile mcp"
```

For the hardened stack use `docker compose -f docker-compose.server.yml --env-file .env.server` (no profile needed).

1. **Back up the database**
   ```bash
   docker exec verity_postgres pg_dump -U verity -d verity_dam -Fc > ~/verity_before_mcp_$(date +%Y%m%d%H%M).dump
   ```
2. **Update code**: `git fetch && git checkout <branch-or-main> && git pull`.
3. **Internal service key**: `.env` must contain `VERITY_INTERNAL_SERVICE_KEY`
   (check with `grep -c '^VERITY_INTERNAL_SERVICE_KEY=.' .env`; prints `1` if set,
   without showing the value). If missing: append a line with a value from
   `openssl rand -base64 32`.
4. **Migrate** (worker image carries the migrations):
   ```bash
   $C build verity-dam-worker
   $C run --rm --no-deps verity-dam-worker python -m scripts.apply_native_migrations --dry-run
   $C run --rm --no-deps verity-dam-worker python -m scripts.apply_native_migrations
   ```
5. **Start / rebuild**:
   ```bash
   $C up -d --build verity-dam-app verity-dam-worker verity-dam-mcp
   curl -s http://127.0.0.1:8000/health      # {"status":"ok","service":"verity-dam-mcp",...}
   ```
   Do not set `MCP_HOST=127.0.0.1` in the container: that turns on the SDK's
   DNS-rebinding guard and rejects the public `Host` header.
6. **Tunnel rule** (Cloudflare Zero Trust → Networks → Tunnels → the tunnel →
   Public hostnames → Add):
   - Subdomain/domain: same hostname as the app (e.g. `veritydam.example.com`)
   - Path: `^/mcp`
   - Service: `http://127.0.0.1:8000` (connector uses host networking; use
     `http://verity-dam-mcp:8000` if `cloudflared` runs inside the compose network)
   - Move it **above** the catch-all app rule.

   Equivalent `ingress` (API / `config.yml`), order is significant:
   ```yaml
   ingress:
     - hostname: veritydam.example.com
       path: ^/mcp
       service: http://127.0.0.1:8000
     - hostname: veritydam.example.com
       service: http://127.0.0.1:3000
       originRequest:
         httpHostHeader: veritydam.example.com
     - service: http_status:404
   ```
7. **Verify from outside**
   ```bash
   curl -s -o /dev/null -D - -X POST https://veritydam.example.com/mcp -H 'Content-Type: application/json' -d '{}' | grep -i -E '^HTTP|www-authenticate'
   # HTTP/2 401 + www-authenticate: Bearer realm="VerityDAM MCP"   (404 = tunnel rule missing)
   ```
   Then open the settings page: both pills green. Create a key, connect one
   client (Claude Code: `claude mcp add ...` from the page), run a sample prompt,
   and confirm the call appears in **Nhật ký gọi MCP**.

## Rollback

- `$C stop verity-dam-mcp` and delete the tunnel rule: `/mcp` returns to the app (404). Web app is unaffected.
- Migration 0052 is additive; leave it in place.

## Configuration reference

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `MCP_RATE_LIMIT_PER_MINUTE` | mcp | `60` | Requests per minute per API key (sliding window, per process). `0` disables. |
| `VERITY_MCP_INTERNAL_URL` | app | `http://verity-dam-mcp:8000` | Status probe target. |
| `VERITY_MCP_PUBLIC_URL` | app | `$BETTER_AUTH_URL/mcp` | URL shown on the page and probed publicly. Set it when the MCP hostname differs from `BETTER_AUTH_URL`. |
| `COMPOSE_PROFILES` | `.env` | — | Set `mcp` on hosts whose CD runs plain `docker compose up` so the MCP service is built and started on every deploy. |
| `VERITY_MCP_HOST_PORT` | compose | `8000` | Host loopback port for a host-network connector. |
