import type { Lead } from "../calls/types.js";
import type { AgentConnection } from "../websocket/twilioMedia.js";
import type { AgentContextStrategy, PreparedAgent } from "./contextStrategy.js";

/**
 * Stand-in strategy for MOCK_EXTERNAL_SERVICES=true.
 *
 * Exercises the full HTTP/state workflow - including the calendar-tool gate -
 * without contacting Lyzr or creating real agents.
 */
export class MockContextStrategy implements AgentContextStrategy {
  readonly name = "mock-clone-agent";
  readonly prepared: Array<{ lead: Lead; callId: string }> = [];

  async prepareCallAgent(baseAgentId: string, lead: Lead, callId: string): Promise<PreparedAgent> {
    this.prepared.push({ lead, callId });
    return {
      agentId: `mock-agent-${callId}`,
      cloned: true,
      strategy: this.name,
      removedFields: ["_id", "user_id"],
    };
  }
}

/**
 * Agent-side stand-in for mock mode: accepts captured audio and reports ready,
 * so the bridge's full lifecycle runs without joining a real LiveKit room.
 */
export async function mockConnectAgent(): Promise<AgentConnection> {
  let open = true;
  return {
    capture: () => undefined,
    isReady: () => open,
    close: async () => {
      open = false;
    },
  };
}
