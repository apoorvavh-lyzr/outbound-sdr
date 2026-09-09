import type { Logger } from "pino";
import type { CallRepository } from "../db/repository.js";
import type { LyzrClient } from "./client.js";

/**
 * Deletes per-call agent clones once they are past the retention window.
 *
 * Every outbound call creates an agent, so without this the account would
 * accumulate one dead agent per call forever. Cleanup is deliberately
 * conservative: it only touches calls that have COMPLETED, it clears the stored
 * id only after the delete succeeds (so a failure is retried on the next
 * sweep), and a failure never affects call state.
 */
export class ClonedAgentCleanup {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: CallRepository,
    private readonly client: LyzrClient,
    private readonly retentionHours: number,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.client.supportsAgentDeletion && this.retentionHours > 0;
  }

  /** Runs one sweep. Returns how many agents were deleted. */
  async sweep(): Promise<number> {
    if (!this.enabled) return 0;

    const cutoff = new Date(Date.now() - this.retentionHours * 3600_000).toISOString();
    const expired = await this.repository.findExpiredClonedAgents(cutoff);

    let deleted = 0;
    for (const { id, agentId } of expired) {
      try {
        await this.client.deleteAgent(agentId);
        await this.repository.clearClonedAgent(id);
        deleted++;
      } catch (err) {
        // Left in place so the next sweep retries it.
        this.logger.warn(
          { event: "cloned_agent_cleanup_failed", callId: id, err: String(err) },
          "could not delete cloned agent",
        );
      }
    }

    if (deleted > 0) {
      this.logger.info({ event: "cloned_agents_cleaned", deleted }, "deleted expired agent clones");
    }
    return deleted;
  }

  /** Starts a periodic sweep. `unref` keeps it from holding the process open. */
  start(intervalMs = 3600_000): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
