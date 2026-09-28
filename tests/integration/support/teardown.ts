import { afterAll } from "vitest";
import { pool } from "./db";

afterAll(async () => {
  await pool.end();
});
