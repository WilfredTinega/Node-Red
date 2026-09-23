// Runs in a short-lived helper container started by the dashboard. It swaps
// the dashboard's container for one running the new image, which the
// dashboard can't do to itself because stopping it would stop the swap.
// Usage: node self-update.js <dashboard container id> <image ref>
import { createDocker } from './docker.js';

const [target, ref] = process.argv.slice(2);
if (!target || !ref || !process.env.DOCKER_API) {
  console.error('usage: DOCKER_API=… node self-update.js <container> <image>');
  process.exit(2);
}

// Give the dashboard a moment to answer the browser before it goes down.
await new Promise((r) => setTimeout(r, 2000));
try {
  const id = await createDocker(process.env.DOCKER_API).recreate(target, ref, (m) => console.log(m));
  console.log(`Dashboard now runs ${ref} (${id.slice(0, 12)})`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
