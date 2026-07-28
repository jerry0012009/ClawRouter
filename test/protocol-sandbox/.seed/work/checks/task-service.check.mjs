import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/storage/task-store.mjs";
import { TaskService } from "../src/services/task-service.mjs";

test("TaskService.listOpen returns only open tasks without formatting", () => {
  const store = new TaskStore([
    { id: "T1", title: "open", status: "open" },
    { id: "T2", title: "done", status: "done" },
  ]);
  const service = new TaskService(store);
  assert.deepEqual(service.listOpen(), [{ id: "T1", title: "open", status: "open" }]);
});
