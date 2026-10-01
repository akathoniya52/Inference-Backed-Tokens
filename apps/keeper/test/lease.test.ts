import { Leases } from '@ibt/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { systemClock } from '../src/ctx.js';
import { createLease, type Lease } from '../src/lease.js';
import { createScheduler, type Scheduler } from '../src/scheduler.js';
import { makeKeeperCtx, type TestKeeperCtx } from './helpers.js';

const TTL_MS = 200;
const RENEW_MS = 40;

interface Instance {
  lease: Lease;
  scheduler: Scheduler;
  runs: number;
  lost: number;
}

describe('keeper lease', () => {
  let ctx: TestKeeperCtx;
  const started: Lease[] = [];

  beforeAll(async () => {
    ctx = await makeKeeperCtx();
  });

  afterAll(async () => {
    await Promise.all(started.map((lease) => lease.stop()));
    await ctx.close();
  });

  function instance(name: string, holder: string): Instance {
    const scheduler = createScheduler({ logger: ctx.logger });
    const inst: Instance = {
      scheduler,
      runs: 0,
      lost: 0,
      lease: createLease({
        name,
        holder,
        ttlMs: TTL_MS,
        renewMs: RENEW_MS,
        clock: systemClock,
        logger: ctx.logger,
        onAcquired: () => scheduler.start(),
        onLost: () => {
          inst.lost += 1;
          scheduler.stop();
        },
      }),
    };
    scheduler.add('count', '* * * * *', () => {
      inst.runs += 1;
      return Promise.resolve();
    });
    started.push(inst.lease);
    return inst;
  }

  it('two instances: exactly one holds the lease and runs jobs', async () => {
    const a = instance('keeper-a', 'holder-a');
    const b = instance('keeper-a', 'holder-b');
    await a.lease.start();
    await b.lease.start();

    expect(a.lease.isHeld()).toBe(true);
    expect(b.lease.isHeld()).toBe(false);

    await Promise.all([a.scheduler.runNow('count'), b.scheduler.runNow('count')]);
    expect(a.runs + b.runs).toBe(1);
    expect(a.runs).toBe(1);

    const doc = await Leases.findOne({ name: 'keeper-a' }).lean();
    expect(doc?.owner).toBe('holder-a');
  });

  it('takes over after the TTL when the holder crashes, and the old holder loses it', async () => {
    const a = instance('keeper-b', 'holder-a');
    const b = instance('keeper-b', 'holder-b');
    await a.lease.start();
    await b.lease.start();
    expect(a.lease.isHeld()).toBe(true);

    const crashedAt = Date.now();
    a.lease.pause();

    await vi.waitFor(() => expect(b.lease.isHeld()).toBe(true), { timeout: 3000, interval: 10 });
    expect(Date.now() - crashedAt).toBeGreaterThanOrEqual(TTL_MS - RENEW_MS);

    await b.scheduler.runNow('count');
    expect(b.runs).toBe(1);

    a.lease.resume();
    await vi.waitFor(() => expect(a.lost).toBe(1), { timeout: 3000, interval: 10 });
    expect(a.lease.isHeld()).toBe(false);
    expect(await a.scheduler.runNow('count')).toBe(false);
    expect(a.runs).toBe(0);
  });

  it('scheduler skips an overlapping run of the same job', async () => {
    const scheduler = createScheduler({ logger: ctx.logger });
    let release: () => void = () => undefined;
    let runs = 0;
    scheduler.add('slow', '* * * * *', async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    scheduler.start();
    const first = scheduler.runNow('slow');
    expect(await scheduler.runNow('slow')).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    scheduler.stop();
  });
});
