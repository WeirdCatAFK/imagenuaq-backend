// Clock-driven jobs: checks that need no human action, each found by its unique `name`. A job that
// notifies writes with a dedup key, so running it again, or catching up after a restart, sends nothing twice.
import cron from 'node-cron';

import documents from './access/orchestration/documents.js';
import notifications from './access/orchestration/notifications.js';

const TIME_ZONE = 'America/Mexico_City';


export const JOBS = [
  {
    name: 'birthdays',
    schedule: '0 * * * *',
    description: "Tells everyone about today's birthdays.",
    run: (now) => notifications.notifyBirthdays(now),
  },
  {
    name: 'file-expiry',
    schedule: '0 3 * * *',
    description: 'Deletes files past retention (RF-ARC-01).',
    run: (now) => documents.expire(now),
  },
  {
    name: 'file-expiry-warning',
    schedule: '0 8 * * *',
    description: "Warns a week ahead that a closed project's files are about to be deleted.",
    run: (now) => notifications.notifyFilesExpiring(now, 7),
  },
  {
    name: 'notifications-cleanup',
    schedule: '30 3 * * *',
    description: 'Deletes notifications older than six months.',
    run: () => notifications.deleteExpired(),
  },
];

/**
 * Runs one job now, by name.
 *
 * @throws {Error} on an unknown name, and whatever the job throws.
 */
export async function runJob(name, now = new Date()) {
  const job = JOBS.find((candidate) => candidate.name === name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  return job.run(now);
}

/**
 * Schedules every job. A failed run is logged and retried at its next tick; a run that changed
 * something logs its counts.
 * shortcut: one scheduler per API process; give it a leader lock if the API ever runs as more than one instance.
 */
export function start() {
  for (const job of JOBS) {
    cron.schedule(
      job.schedule,
      () =>
        runJob(job.name).then(
          (result) => {
            if (Object.values(result ?? {}).some((count) => count > 0)) {
              console.log(`Job ${job.name}:`, JSON.stringify(result));
            }
          },
          (err) => console.error(`Job ${job.name} failed:`, err),
        ),
      { name: job.name, timezone: TIME_ZONE, noOverlap: true },
    );
  }
}

/** Stops every job, waiting for one in flight to finish. */
export function stop() {
  return cron.shutdown();
}
