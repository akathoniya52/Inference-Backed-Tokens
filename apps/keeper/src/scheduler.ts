import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

export type JobFn = () => Promise<void>;

export interface Scheduler {
  add(name: string, expression: string, fn: JobFn): void;
  /** Starts the cron triggers; jobs only run while started (i.e. while the lease is held). */
  start(): void;
  stop(): void;
  isStarted(): boolean;
  /** Runs a job immediately; resolves `false` when stopped or when the job is already running. */
  runNow(name: string): Promise<boolean>;
  /** Waits for running jobs to end, at most `timeoutMs`; resolves whether all of them did. */
  drain(timeoutMs: number): Promise<boolean>;
}

interface Job {
  expression: string;
  fn: JobFn;
  running: boolean;
  /** The run in flight, so `drain` can wait for it. */
  current: Promise<void> | null;
  task: ScheduledTask | null;
}

export function createScheduler({ logger }: { logger: Logger }): Scheduler {
  const jobs = new Map<string, Job>();
  let started = false;

  async function run(name: string): Promise<boolean> {
    const job = jobs.get(name);
    if (!job) throw new Error(`unknown job ${name}`);
    if (!started) return false;
    if (job.running) {
      logger.warn({ job: name }, 'job still running; skipping overlapping run');
      return false;
    }
    job.running = true;
    const startedAt = Date.now();
    job.current = (async () => {
      try {
        await job.fn();
        logger.debug({ job: name, ms: Date.now() - startedAt }, 'job finished');
      } catch (err) {
        logger.error({ err, job: name }, 'job failed');
      } finally {
        job.running = false;
        job.current = null;
      }
    })();
    await job.current;
    return true;
  }

  function schedule(name: string, job: Job): void {
    job.task ??= cron.schedule(job.expression, () => run(name), { timezone: 'UTC', name });
  }

  return {
    add(name, expression, fn) {
      if (jobs.has(name)) throw new Error(`job ${name} already registered`);
      if (!cron.validate(expression)) throw new Error(`invalid cron expression for ${name}`);
      const job: Job = { expression, fn, running: false, current: null, task: null };
      jobs.set(name, job);
      if (started) schedule(name, job);
    },
    start() {
      if (started) return;
      started = true;
      for (const [name, job] of jobs) schedule(name, job);
    },
    stop() {
      started = false;
      for (const job of jobs.values()) {
        void job.task?.destroy();
        job.task = null;
      }
    },
    isStarted: () => started,
    runNow: run,
    async drain(timeoutMs) {
      const running = [...jobs.values()].flatMap((job) => (job.current ? [job.current] : []));
      if (running.length === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([Promise.all(running).then(() => true), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
