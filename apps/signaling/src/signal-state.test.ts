import test from "node:test";
import assert from "node:assert/strict";
import { LocalSignalState } from "./signal-state.js";

test("local signal state assigns stable sequence numbers for duplicate events", async () => {
  const state = new LocalSignalState();
  assert.deepEqual(await state.claim("room-1", "event-1"), { duplicate: false, sequence: 1 });
  assert.deepEqual(await state.claim("room-1", "event-1"), { duplicate: true, sequence: 1 });
  assert.deepEqual(await state.claim("room-1", "event-2"), { duplicate: false, sequence: 2 });
  await state.close();
});
