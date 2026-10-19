// Lint setup. It checks one thing, the comment rule in eslint-rules/comment-policy.js.
// swagger.js is skipped: it is a hand-written API description, not code.
import { defineConfig, globalIgnores } from "eslint/config";

import commentPolicy from "./eslint-rules/comment-policy.js";

export default defineConfig([
  globalIgnores(["node_modules", "dbml", "migrations", "src/swagger.js"]),
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { local: { rules: { "comment-policy": commentPolicy } } },
    rules: { "local/comment-policy": "error" },
  },
]);
