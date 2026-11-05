import { resolve } from "node:path";
import type { Config } from "./config.js";
import { mapCodebase, type MapOptions, type MapResult } from "./pipeline.js";

export type JobView =
  | { state: "running"; progress: string }
  | { state: "done"; result: MapResult }
  | { state: "failed"; error: string };

interface Job {
  progress: string;
  outcome?: { result: MapResult } | { error: string };
  settled: Promise<void>;
}

/**
 * A mapping can take far longer than an MCP client is willing to wait, and that limit differs
 * between opencode versions. So the work runs detached from the call: a call starts the job or
 * attaches to the one already running for that directory, waits a bounded time, and reports.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly config: Config,
    private readonly mapOptions: Pick<MapOptions, "chat"> = {},
  ) {}

  async run(root: string, force: boolean, waitMs: number): Promise<JobView> {
    const key = resolve(root);
    let job = this.jobs.get(key);
    if (!job) {
      job = this.start(key, force);
      this.jobs.set(key, job);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((done) => {
      timer = setTimeout(done, waitMs);
    });
    await Promise.race([job.settled, timeout]);
    clearTimeout(timer);

    if (!job.outcome) return { state: "running", progress: job.progress };
    // Delivered once. The next call starts fresh and costs nothing if nothing changed.
    this.jobs.delete(key);
    return "result" in job.outcome
      ? { state: "done", result: job.outcome.result }
      : { state: "failed", error: job.outcome.error };
  }

  private start(root: string, force: boolean): Job {
    const job: Job = { progress: "starting", settled: Promise.resolve() };
    job.settled = mapCodebase(root, this.config, {
      ...this.mapOptions,
      force,
      onProgress: (message) => {
        job.progress = message;
      },
    }).then(
      (result) => {
        job.outcome = { result };
      },
      (error: Error) => {
        job.outcome = { error: error.message };
      },
    );
    return job;
  }
}
