import { setTimeout as delay } from 'node:timers/promises';

const transient = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENETUNREACH', '57P03', '08006']);
const canRetry = error => transient.has(error?.code) || error?.errors?.some(canRetry);

// A sleeping database may refuse the first connection while its container boots.
// Retry only connection failures; configuration and migration errors fail immediately.
export async function initializeDatabase(initialize, { wait = delay, onRetry = () => {}, attempts = 6 } = {}) {
  for (let n = 1; ; n++) {
    try { return await initialize(); }
    catch (error) {
      if (n >= attempts || !canRetry(error)) throw error;
      const milliseconds = 1000 * 2 ** (n - 1);
      onRetry(n, milliseconds);
      await wait(milliseconds);
    }
  }
}
