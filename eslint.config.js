// Lint configuration. For now it enforces one thing, the comment policy in
// eslint-rules/comment-policy.js. swagger.js is excluded: it is a hand-written OpenAPI
// document, not code.
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
