import { describe, expect, it } from "vitest";
import { sortConnectionsForPriority } from "../../src/shared/utils/connectionPriority.js";

describe("connection Priority ordering", () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");

  it("puts usable accounts before quota-locked accounts without changing saved priority", () => {
    const connections = [
      { id: "locked-1", priority: 1, modelLock_modelA: "2026-08-07T13:00:00.000Z" },
      { id: "ready-3", priority: 3 },
      { id: "ready-2", priority: 2 },
      { id: "locked-4", priority: 4, modelLock_modelB: "2026-08-07T14:00:00.000Z" },
    ];

    const sorted = sortConnectionsForPriority(connections, { now });

    expect(sorted.map((connection) => connection.id)).toEqual([
      "ready-2",
      "ready-3",
      "locked-1",
      "locked-4",
    ]);
    expect(connections.map((connection) => connection.priority)).toEqual([1, 3, 2, 4]);
  });

  it("restores configured priority after the quota lock expires", () => {
    const connections = [
      { id: "priority-1", priority: 1, modelLock_modelA: "2026-08-07T11:59:59.000Z" },
      { id: "priority-2", priority: 2 },
    ];

    expect(sortConnectionsForPriority(connections, { now }).map((connection) => connection.id))
      .toEqual(["priority-1", "priority-2"]);
  });
});
