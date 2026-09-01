// The CLI is a separate process from the API, so it does not inherit the `--env-file`
// the npm scripts pass to node. `process.loadEnvFile` (Node >= 20.12) reads the same
// .env, which keeps one file as the source of truth instead of adding dotenv.
import { defineConfig, env } from 'prisma/config';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env — the URL is expected to come from the real environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
