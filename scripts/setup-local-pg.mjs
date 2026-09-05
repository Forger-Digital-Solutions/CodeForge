import { spawn } from "node:child_process";

// Idempotent local PostgreSQL setup for CodeForge tests, run inside WSL2 Ubuntu.
//
// Security note (CF-15S): earlier versions of this script appended an
// unrestricted `host all all 0.0.0.0/0 md5` rule to pg_hba.conf on every run,
// which both over-exposed the cluster (any database, any user, any IPv4
// address) and duplicated itself on repeated execution. This version scopes
// access to exactly the CodeForge test database/user, restricts the source
// to this machine's actual WSL2 virtual subnet (detected at run time, never
// hardcoded, never 0.0.0.0/0), and is idempotent: re-running it replaces its
// own previously-managed block instead of appending another copy.

const MARKER_BEGIN = "# BEGIN codeforge-test-pg (managed by scripts/setup-local-pg.mjs)";
const MARKER_END = "# END codeforge-test-pg (managed by scripts/setup-local-pg.mjs)";
const HBA_PATH = "/etc/postgresql/16/main/pg_hba.conf";
const CONF_PATH = "/etc/postgresql/16/main/postgresql.conf";

const child = spawn("wsl", ["-u", "root", "-d", "Ubuntu", "--cd", "/tmp", "-e", "bash"], {
  stdio: ["pipe", "inherit", "inherit"],
});

const commands = [
  "set -e",
  "service postgresql start",
  "su - postgres -c \"psql -c \\\"CREATE USER codeforge_test WITH PASSWORD 'cf_test_pass_123' SUPERUSER;\\\"\" || true",
  "su - postgres -c \"psql -c \\\"CREATE DATABASE codeforge_test_db OWNER codeforge_test;\\\"\" || true",
  "su - postgres -c \"psql -c \\\"ALTER USER codeforge_test WITH PASSWORD 'cf_test_pass_123';\\\"\"",
  // Detect this machine's actual WSL2 virtual subnet. Never hardcode it,
  // never fall back to 0.0.0.0/0 — a detection failure should stop the
  // script, not silently over-expose the cluster.
  "WSL_SUBNET=$(ip -4 -o addr show eth0 | awk '{print $4}' | head -1)",
  'if [ -z "$WSL_SUBNET" ]; then echo "Could not detect WSL2 subnet on eth0; refusing to widen pg_hba.conf" >&2; exit 1; fi',
  "echo Detected WSL2 subnet: $WSL_SUBNET",
  // Idempotent pg_hba.conf update: strip any prior managed block (by marker,
  // fixed-string match, no regex) and any earlier unmarked scoped rule this
  // script or a manual fix may have left behind, then write exactly one
  // fresh, narrowly-scoped rule.
  `grep -vF '${MARKER_BEGIN}' ${HBA_PATH} | grep -vF '${MARKER_END}' | grep -vF 'host codeforge_test_db codeforge_test' > /tmp/pg_hba.new`,
  `mv /tmp/pg_hba.new ${HBA_PATH}`,
  `printf '%s\\n' "${MARKER_BEGIN}" "host codeforge_test_db codeforge_test $WSL_SUBNET md5" "${MARKER_END}" >> ${HBA_PATH}`,
  // Idempotent listen_addresses: only append if no active (uncommented)
  // listen_addresses line already exists.
  `grep -Eq "^listen_addresses[[:space:]]*=" ${CONF_PATH} || echo "listen_addresses = '*'" >> ${CONF_PATH}`,
  "service postgresql restart",
  "su - postgres -c \"pg_isready\"",
  "exit\n",
];

child.stdin.write(commands.join("\n"));
child.stdin.end();

child.on("close", (code) => {
  console.log("PG setup exited with code:", code);
  process.exit(code ?? 0);
});
