import { spawn } from "node:child_process";

const child = spawn("wsl", ["-u", "root", "-d", "Ubuntu", "--cd", "/tmp", "-e", "bash"], {
  stdio: ["pipe", "inherit", "inherit"],
});

const commands = [
  "service postgresql start",
  "su - postgres -c \"psql -c \\\"CREATE USER codeforge_test WITH PASSWORD 'cf_test_pass_123' SUPERUSER;\\\"\" || true",
  "su - postgres -c \"psql -c \\\"CREATE DATABASE codeforge_test_db OWNER codeforge_test;\\\"\" || true",
  "su - postgres -c \"psql -c \\\"ALTER USER codeforge_test WITH PASSWORD 'cf_test_pass_123';\\\"\"",
  "echo 'host all all 0.0.0.0/0 md5' >> /etc/postgresql/16/main/pg_hba.conf",
  "echo 'host all all ::0/0 md5' >> /etc/postgresql/16/main/pg_hba.conf",
  "echo \"listen_addresses = '*'\" >> /etc/postgresql/16/main/postgresql.conf",
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
