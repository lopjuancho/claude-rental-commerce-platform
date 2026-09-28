export function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:5432/${process.env.TEST_DB_NAME ?? "rental_commerce_test"}`
  );
}
