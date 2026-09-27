import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { HubspotClient, type FetchLike } from "../src/hubspot/client.js";

const silent = pino({ level: "silent" });
const LEAD = "victor.hou@varisource.com";

interface Stub {
  contact?: { id: string; ownerId: string | null } | null;
  owner?: { id: string; email?: string; firstName?: string; lastName?: string } | null;
  searchStatus?: number;
  calls: { path: string; body: unknown }[];
  searches: number;
  ownerFetches: number;
}

function makeStub(overrides: Partial<Stub> = {}) {
  const stub: Stub = { calls: [], searches: 0, ownerFetches: 0, ...overrides };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace("https://api.hubapi.com", "");
    stub.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path === "/crm/v3/objects/contacts/search") {
      stub.searches += 1;
      if (stub.searchStatus && stub.searchStatus !== 200) return json(stub.searchStatus, { message: "nope" });
      const c = stub.contact;
      return json(200, c ? { results: [{ id: c.id, properties: { email: LEAD, hubspot_owner_id: c.ownerId } }] } : { results: [] });
    }
    if (path.startsWith("/crm/v3/owners/")) {
      stub.ownerFetches += 1;
      return stub.owner ? json(200, stub.owner) : json(404, {});
    }
    if (path === "/crm/v3/objects/calls" || path === "/crm/v3/objects/notes") return json(201, { id: "obj-1" });
    if (path.startsWith("/crm/v3/objects/contacts/")) return json(200, { id: "c1" });
    throw new Error(`unexpected ${path}`);
  };
  return { stub, fetchImpl };
}

const owner = { id: "85561204", email: "Sid@Lyzr.ai", firstName: "Siddharth", lastName: "Asokan" };

describe("ownerForLead", () => {
  it("resolves contact then owner, lower-casing the email", async () => {
    const { stub, fetchImpl } = makeStub({ contact: { id: "58087682658", ownerId: "85561204" }, owner });
    const client = new HubspotClient({ accessToken: "pat-x" }, silent, fetchImpl);
    await expect(client.ownerForLead(LEAD)).resolves.toEqual({
      id: "85561204", email: "sid@lyzr.ai", name: "Siddharth Asokan",
    });
    expect((stub.calls[0]!.body as { filterGroups: unknown[] }).filterGroups).toBeTruthy();
  });

  it("returns null for an unknown contact and for an unassigned one", async () => {
    const unknown = makeStub({ contact: null });
    await expect(new HubspotClient({ accessToken: "x" }, silent, unknown.fetchImpl).ownerForLead(LEAD)).resolves.toBeNull();

    const unassigned = makeStub({ contact: { id: "1", ownerId: null }, owner });
    await expect(new HubspotClient({ accessToken: "x" }, silent, unassigned.fetchImpl).ownerForLead(LEAD)).resolves.toBeNull();
    expect(unassigned.stub.ownerFetches).toBe(0);
  });

  it("caches owners across lookups", async () => {
    const { stub, fetchImpl } = makeStub({ contact: { id: "1", ownerId: "85561204" }, owner });
    const client = new HubspotClient({ accessToken: "x" }, silent, fetchImpl);
    await client.ownerForLead(LEAD);
    await client.ownerForLead(LEAD);
    expect(stub.searches).toBe(2);
    expect(stub.ownerFetches).toBe(1);
  });

  it("surfaces a HubSpot failure as an upstream error", async () => {
    const { fetchImpl } = makeStub({ searchStatus: 500 });
    await expect(new HubspotClient({ accessToken: "x" }, silent, fetchImpl).ownerForLead(LEAD)).rejects.toMatchObject({
      code: "hubspot_error",
    });
  });
});

describe("waitForOwner", () => {
  it("returns as soon as an owner appears", async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStub({ contact: { id: "1", ownerId: null }, owner });
      const client = new HubspotClient({ accessToken: "x" }, silent, stub.fetchImpl);
      const pending = client.waitForOwner(LEAD, 10_000, 1_000);
      // Assignment lands after the first poll.
      stub.stub.contact = { id: "1", ownerId: "85561204" };
      await vi.advanceTimersByTimeAsync(1_200);
      await expect(pending).resolves.toMatchObject({ email: "sid@lyzr.ai" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up quietly when nobody is assigned", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = makeStub({ contact: { id: "1", ownerId: null } });
      const client = new HubspotClient({ accessToken: "x" }, silent, fetchImpl);
      const pending = client.waitForOwner(LEAD, 3_000, 1_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when HubSpot is failing", async () => {
    const { fetchImpl } = makeStub({ searchStatus: 503 });
    const client = new HubspotClient({ accessToken: "x" }, silent, fetchImpl);
    await expect(client.waitForOwner(LEAD, 0)).resolves.toBeNull();
  });
});

describe("write-back", () => {
  it("logs a call associated with the contact", async () => {
    const { stub, fetchImpl } = makeStub();
    const client = new HubspotClient({ accessToken: "x" }, silent, fetchImpl);
    await client.logCall("58087682658", {
      timestamp: "2026-09-27T10:00:00.000Z", title: "Lyzr AI SDR call",
      body: "Booked a demo for Tuesday.", status: "COMPLETED", durationMs: 92_000, toNumber: "+919876543210",
    });
    const body = stub.calls[0]!.body as { properties: Record<string, string>; associations: { types: { associationTypeId: number }[] }[] };
    expect(body.properties.hs_call_direction).toBe("OUTBOUND");
    expect(body.properties.hs_call_duration).toBe("92000");
    expect(body.associations[0]!.types[0]!.associationTypeId).toBe(194);
  });

  it("attaches a note and updates properties", async () => {
    const { stub, fetchImpl } = makeStub();
    const client = new HubspotClient({ accessToken: "x" }, silent, fetchImpl);
    await client.addNote("c1", "Summary of the call.", "2026-09-27T10:00:00.000Z");
    await client.updateContact("c1", { demo_booked: "true" });
    expect(stub.calls.map((c) => c.path)).toEqual(["/crm/v3/objects/notes", "/crm/v3/objects/contacts/c1"]);
  });

  it("skips an empty property update entirely", async () => {
    const { stub, fetchImpl } = makeStub();
    await new HubspotClient({ accessToken: "x" }, silent, fetchImpl).updateContact("c1", {});
    expect(stub.calls).toHaveLength(0);
  });
});
