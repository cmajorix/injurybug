// npm run deploy — builds web/ and deploys the Worker. Set DEPLOY_DOMAIN (in the environment or an
// untracked api/.env) to serve it on a custom domain whose zone is on the same Cloudflare account;
// without it the Worker is only on workers.dev.
import { execSync } from "node:child_process";

try {
  process.loadEnvFile(".env");
} catch {} // no .env: environment only

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("npm --prefix ../web run build");
const domain = process.env.DEPLOY_DOMAIN?.trim();
run(`npx wrangler deploy${domain ? ` --domain ${domain}` : ""}`);
