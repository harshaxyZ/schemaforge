# Deploying SchemaForge

This folder runs the SchemaForge MCP servers on a public HTTPS URL so a TrueForge agent can reach them from anywhere. The stack is five containers on one host:

| Service | Role | Exposed |
|---|---|---|
| `gateway` | Caddy reverse proxy with automatic HTTPS | ports 80 and 443 |
| `core` | read-only and shadow tools | through the gateway at `/core/mcp` |
| `executor` | `execute_migration` only | through the gateway at `/executor/mcp` |
| `prod` | PostgreSQL 16 demo production target | no, internal network only |
| `shadow` | PostgreSQL 16 rehearsal target | no, internal network only |

`core` and `executor` sit on separate internal networks, so the executor cannot reach the shadow database and neither database is reachable from the internet. Both MCP endpoints require a bearer key, and each key is different.

The approval CLI never runs on the server. The operator keeps the signing secret in a local `.env.approval` and mints tokens on their own machine.

> [!WARNING]
> Deploy the seeded demo databases only. Until SF-SEC-01 to SF-SEC-03 in [`docs/review/security-review.md`](../docs/review/security-review.md) are fixed, do not point SchemaForge at a real production database.

## Option A: AWS EC2 (recommended)

1. **Launch an instance.** In the EC2 console, launch Amazon Linux 2023 on `t3.small` or larger with 20 GB of storage. Paste [`aws/user-data.sh`](aws/user-data.sh) into **Advanced details → User data**.
2. **Open the firewall.** In the security group, allow inbound TCP 22 from your IP only, and TCP 80 and 443 from anywhere. Do not open 5432, 3100 or 3101.
3. **Pick a hostname.** Attach an Elastic IP. Point a DNS `A` record at it, or use the free `sslip.io` name `<ip-with-dashes>.sslip.io` (for `203.0.113.10`, use `203-0-113-10.sslip.io`).
4. **Create the secrets file.** SSH in as `ec2-user`:

   ```bash
   cd ~/schemaforge
   cp deploy/.env.example deploy/.env
   for k in SF_ADMIN_DB_PASSWORD SF_READER_DB_PASSWORD SF_EXECUTOR_DB_PASSWORD SF_SHADOW_DB_PASSWORD \
            SF_CORE_MCP_API_KEY SF_EXECUTOR_MCP_API_KEY SF_APPROVAL_SECRET; do
     sed -i "s|^$k=.*|$k=$(openssl rand -hex 32)|" deploy/.env
   done
   sed -i "s|^SF_DOMAIN=.*|SF_DOMAIN=203-0-113-10.sslip.io|" deploy/.env   # your hostname
   chmod 600 deploy/.env
   ```

5. **Start the stack.**

   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build --wait
   curl https://$(grep ^SF_DOMAIN deploy/.env | cut -d= -f2)/core/health
   ```

   Caddy requests the TLS certificate on first start. That takes a few seconds and needs port 80 open.

6. **Copy two values to your own machine**, over SSH, never through chat: `SF_APPROVAL_SECRET` into your local `.env.approval`, and the two MCP keys for the TrueForge step below.

## Option B: any Docker host

The same compose file runs on any Linux VM with Docker Compose v2 and ports 80 and 443 open: Lightsail, DigitalOcean, Hetzner or a home server behind a public IP. Follow steps 3 to 6 above.

To try it on your own computer first, set `SF_DOMAIN=localhost`, `HTTP_PORT=8080` and `HTTPS_PORT=8443`. Caddy then uses its own local certificate authority, so pass `-k` to `curl`.

## Connect TrueForge

TrueForge runs on the operator's machine (`npx @truefoundry/trueforge@0.2.1`). Point the provisioning script at the public endpoints:

```bash
export SF_CORE_MCP_API_KEY=<core key from deploy/.env>
export SF_EXECUTOR_MCP_API_KEY=<executor key from deploy/.env>
node scripts/trueforge/provision.mjs \
  --core-url https://<SF_DOMAIN>/core/mcp \
  --executor-url https://<SF_DOMAIN>/executor/mcp \
  --model openai/gpt-5.2
node scripts/trueforge/check.mjs
```

The keys are stored in TrueForge's local connector settings as `Authorization: Bearer` headers. They never go in the repository.

## Operate

| Task | Command |
|---|---|
| Status | `docker compose -f deploy/docker-compose.yml ps` |
| Logs | `docker compose -f deploy/docker-compose.yml logs -f core executor` |
| Update to latest `main` | `git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build` |
| Stop | `docker compose -f deploy/docker-compose.yml down` |
| Reset demo data | `docker compose -f deploy/docker-compose.yml down -v`, then start again |

Rotating a key or password means editing `deploy/.env` and restarting. Database role passwords are applied only when the `prod` volume is first created, so change them with a reset.
