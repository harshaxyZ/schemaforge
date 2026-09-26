# SchemaForge v2.0

**Autonomous Database Migration Reliability Agent**

> Built for the TrueFoundry × Polaris "Agents That Act" hackathon.

SchemaForge is **not** an SQL generator — it is an **agentic database-change control system**. A human provides a natural-language migration objective; SchemaForge orchestrates schema inspection, migration synthesis, sandbox rehearsal, verification, risk reporting, and enforces a **hard approval boundary** before any production mutation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Human Operator                           │
│              (natural-language migration request)                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Server (:3100)                           │
│  ┌───────────┐  ┌────────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  Inspect   │  │ Synthesize │  │ Rehearse │  │   Report    │  │
│  │  Schema    │  │ Migration  │  │ on       │  │   Risk &    │  │
│  │  (read-    │  │ SQL        │  │ Shadow   │  │   Diff      │  │
│  │   only)    │  │            │  │ DB       │  │             │  │
│  └─────┬─────┘  └─────┬──────┘  └────┬─────┘  └──────┬──────┘  │
│        │              │              │               │          │
│        ▼              ▼              ▼               ▼          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Tool Router / Agent Core               │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                   │
│                    ┌────────┴────────┐                           │
│                    │  Approval Gate  │ ◄── Human must approve   │
│                    └────────┬────────┘     before prod write    │
│                             │                                   │
└─────────────────────────────┼───────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   Production DB      │        │    Shadow DB          │
│   PostgreSQL 16      │        │    PostgreSQL 16      │
│   :5433              │        │    :5434              │
│                      │        │                      │
│   db: schemaforge_   │        │   db: schemaforge_   │
│       prod           │        │       shadow         │
│   rw: sf_admin       │        │   rw: sf_shadow      │
│   ro: sf_reader      │        │                      │
└──────────────────────┘        └──────────────────────┘
```

### Key Principles

| Principle | Description |
|-----------|-------------|
| **Read-only inspection** | Production schema is read through `sf_reader` — zero mutation risk during analysis |
| **Shadow rehearsal** | Every migration is executed on an identical shadow DB first |
| **Risk reporting** | Destructive ops (DROP, ALTER TYPE, etc.) are flagged with severity scores |
| **Hard approval gate** | Production mutations require an explicit, time-limited human approval token |
| **Full audit trail** | Every step — inspection, synthesis, rehearsal, approval — is logged |

---

## Prerequisites

- **Docker Desktop** (with Docker Compose v2)
- **Node.js** ≥ 18
- **npm** ≥ 9

---

## Quick Start

### 1. Clone & configure

```bash
git clone <repo-url> schemaforge
cd schemaforge
cp .env.example .env
# Edit .env — set your LLM_API_KEY
```

### 2. Start databases

```bash
docker compose up -d
```

Wait for health checks to pass:

```bash
docker compose ps
```

Both `schemaforge-prod` and `schemaforge-shadow` should show `(healthy)`.

### 3. Verify database setup

```bash
# Connect to prod as admin
psql postgresql://sf_admin:sf_admin_pass@localhost:5433/schemaforge_prod -c "\dt"

# Connect to prod as read-only user
psql postgresql://sf_reader:sf_reader_pass@localhost:5433/schemaforge_prod -c "SELECT * FROM users;"

# Connect to shadow
psql postgresql://sf_shadow:sf_shadow_pass@localhost:5434/schemaforge_shadow -c "\dt"
```

### 4. Install & start the MCP server

```bash
npm install
npm run build
npm start
```

The MCP server starts on port **3100** (configurable via `MCP_SERVER_PORT`).

---

## Project Structure

```
schemaforge/
├── docker/
│   ├── init-prod.sql          # Production DB schema + read-only role
│   └── init-shadow.sql        # Shadow DB schema (mirrors prod)
├── src/
│   ├── server.ts              # MCP server entry point
│   ├── tools/                 # MCP tool implementations
│   │   ├── inspect.ts         # Schema introspection (read-only)
│   │   ├── synthesize.ts      # Migration SQL generation
│   │   ├── rehearse.ts        # Shadow DB execution & verification
│   │   ├── report.ts          # Risk analysis & diff reporting
│   │   └── apply.ts           # Production apply (approval-gated)
│   ├── db/                    # Database connection management
│   ├── approval/              # Token-based approval gate
│   └── utils/                 # Shared helpers
├── docker-compose.yml         # PostgreSQL 16 containers
├── .env                       # Local environment (git-ignored)
├── .env.example               # Documented env template
├── package.json
├── tsconfig.json
└── README.md
```

---

## Demo Walkthrough

### Scenario: Add a `phone` column to the `users` table

1. **Natural-language request →** _"Add an optional phone number field to users"_

2. **SchemaForge inspects** the production schema via `sf_reader` (read-only)

3. **SchemaForge synthesizes** migration SQL:
   ```sql
   ALTER TABLE users ADD COLUMN phone VARCHAR(20);
   ```

4. **SchemaForge rehearses** on shadow DB — executes the migration and verifies the new column exists

5. **SchemaForge reports** risk analysis:
   - Severity: **LOW** (additive, nullable column)
   - No data loss risk
   - No index impact

6. **Human reviews** the report and **approves** with a time-limited token

7. **SchemaForge applies** to production — migration executed via `sf_admin`

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROD_DATABASE_URL` | Read-write PostgreSQL URL for production | — |
| `PROD_READONLY_URL` | Read-only PostgreSQL URL for production | — |
| `SHADOW_DATABASE_URL` | Read-write PostgreSQL URL for shadow/sandbox | — |
| `LLM_API_KEY` | API key for the LLM provider | — |
| `LLM_MODEL` | Model identifier (e.g. `gpt-4o`) | `gpt-4o` |
| `APPROVAL_TOKEN_EXPIRY_SECONDS` | Approval token TTL in seconds | `300` |
| `MCP_SERVER_PORT` | MCP server listen port | `3100` |

---

## Resetting Databases

To wipe both databases and re-initialize from scratch:

```bash
docker compose down -v
docker compose up -d
```

The `-v` flag removes named volumes, so init scripts run again on the next start.

---

## License

MIT .

