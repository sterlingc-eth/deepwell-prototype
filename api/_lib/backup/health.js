/** Called from the existing daily cron sweep (cron-sweep.js) when DEEPWELL_BACKUP=1: the "is the backup overdue?" heartbeat, independent of the backup cron itself. */
import { backupEnabled, makeDeps } from './prod.js';
import { checkBackupHealth } from './engine.js';

export async function sweepBackupHealth() {
  if (!backupEnabled()) return null;
  return checkBackupHealth(makeDeps());
}
