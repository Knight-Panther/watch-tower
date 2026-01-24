import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

type DbResult = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  close: () => Promise<void>;
};

export type Database = DbResult["db"];

export const createDb = (connectionString: string): DbResult => {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
  });

  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
};
