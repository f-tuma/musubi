import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { db } from "./index";

// Runtime migrator — applies the generated SQL in ../drizzle at deploy time
// using drizzle-orm's own migrator (drizzle-orm/node-postgres). The image no
// longer ships the drizzle-kit CLI; this reads the same journal table
// (drizzle.__drizzle_migrations) drizzle-kit writes, so existing databases are
// picked up without re-running applied migrations.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

migrate(db, { migrationsFolder })
  .then(() => {
    console.log(`migrations applied from ${migrationsFolder}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("migration failed:", error);
    process.exit(1);
  });
