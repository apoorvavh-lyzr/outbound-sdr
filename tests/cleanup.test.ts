import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { ClonedAgentCleanup } from "../src/lyzr/cleanup.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { CallRepository } from "../src/db/repository.js";
import { leadSchema } from "../src/calls/types.js";

const silent = pino({ level: "silent" });

let db: Database;
let repo: CallRepository;

async function seedCompletedCall(agentId: string | null, completedAt: string | null) {
  const lead = leadSchema.parse({ phone: "+919999999999", email: "a@b.com", call_mode: "booking" });
  const call = await repo.create(lead, null, "base");
  return repo.update(call.id, {
    status: "completed",
    lyzr_call_agent_id: agentId,
    completed_at: completedAt,
  });
}

function fakeClient(overrides: Partial<{ deleteAgent: (id: string) => Promise<void>; supportsAgentDeletion: boolean }> = {}) {
  const deleted: string[] = [];
  const client = {
    supportsAgentDeletion: overrides.supportsAgentDeletion ?? true,
    deleteAgent: overrides.deleteAgent ?? (async (id: string) => { deleted.push(id); }),
  };
  return { client, deleted };
}

beforeEach(async () => {
  db = createDatabase(undefined);
  await db.migrate();
  repo = new CallRepository(db);
});

afterEach(async () => {
  await db.close();
});

describe("ClonedAgentCleanup", () => {
  const old = new Date(Date.now() - 100 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 1 * 3600_000).toISOString();

  it("deletes clones past the retention window", async () => {
    const call = await seedCompletedCall("agent-old", old);
    const { client, deleted } = fakeClient();

    const removed = await new ClonedAgentCleanup(repo, client as never, 72, silent).sweep();

    expect(removed).toBe(1);
    expect(deleted).toEqual(["agent-old"]);
    // The id is forgotten only after a successful delete.
    expect((await repo.findById(call.id))!.lyzr_call_agent_id).toBeNull();
  });

  it("leaves clones inside the retention window alone", async () => {
    await seedCompletedCall("agent-recent", recent);
    const { client, deleted } = fakeClient();

    expect(await new ClonedAgentCleanup(repo, client as never, 72, silent).sweep()).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("never touches a call that has not completed", async () => {
    const lead = leadSchema.parse({ phone: "+919999999999", email: "a@b.com", call_mode: "booking" });
    const call = await repo.create(lead, null, "base");
    await repo.update(call.id, { status: "streaming", lyzr_call_agent_id: "agent-live" });

    const { client, deleted } = fakeClient();
    await new ClonedAgentCleanup(repo, client as never, 0.0001, silent).sweep();
    expect(deleted).toEqual([]);
  });

  it("keeps the id when deletion fails, so the next sweep retries", async () => {
    const call = await seedCompletedCall("agent-flaky", old);
    const { client } = fakeClient({
      deleteAgent: async () => { throw new Error("upstream down"); },
    });

    const removed = await new ClonedAgentCleanup(repo, client as never, 72, silent).sweep();

    expect(removed).toBe(0);
    expect((await repo.findById(call.id))!.lyzr_call_agent_id).toBe("agent-flaky");
  });

  it("does not affect call state when deletion fails", async () => {
    const call = await seedCompletedCall("agent-flaky", old);
    const { client } = fakeClient({ deleteAgent: async () => { throw new Error("nope"); } });

    await new ClonedAgentCleanup(repo, client as never, 72, silent).sweep();

    const after = await repo.findById(call.id);
    expect(after!.status).toBe("completed");
    expect(after!.error_code).toBeNull();
  });

  it("is disabled when retention is zero or deletion is unsupported", async () => {
    await seedCompletedCall("agent-old", old);
    const { client, deleted } = fakeClient();

    expect(new ClonedAgentCleanup(repo, client as never, 0, silent).enabled).toBe(false);
    expect(await new ClonedAgentCleanup(repo, client as never, 0, silent).sweep()).toBe(0);

    const { client: noDelete } = fakeClient({ supportsAgentDeletion: false });
    expect(new ClonedAgentCleanup(repo, noDelete as never, 72, silent).enabled).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("start() is a no-op when disabled and stop() is always safe", () => {
    const { client } = fakeClient();
    const disabled = new ClonedAgentCleanup(repo, client as never, 0, silent);
    expect(() => { disabled.start(); disabled.stop(); disabled.stop(); }).not.toThrow();
  });

  it("sweeps on the configured interval once started", async () => {
    vi.useFakeTimers();
    try {
      await seedCompletedCall("agent-old", old);
      const { client, deleted } = fakeClient();
      const cleanup = new ClonedAgentCleanup(repo, client as never, 72, silent);

      cleanup.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      cleanup.stop();

      expect(deleted).toEqual(["agent-old"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
