import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTickets, validateTickets } from "../src/tickets.ts";
import { topologicalSort } from "../src/state.ts";

const JSON_SOURCE = JSON.stringify([
  { id: "TKT-001", title: "Greet", description: "Add greet()", dependsOn: [], files: ["src/greet.ts"] },
  { id: "TKT-002", title: "Bid farewell", description: "Add farewell()", dependsOn: ["TKT-001"], complexity: "low" },
]);

test("parses JSON array of tickets", () => {
  const tickets = parseTickets(JSON_SOURCE);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].id, "TKT-001");
  assert.deepEqual(tickets[0].files, ["src/greet.ts"]);
  assert.equal(tickets[1].dependsOn[0], "TKT-001");
  assert.equal(tickets[1].complexity, "low");
});

test("parses markdown heading tickets", () => {
  const src = [
    "## TKT-001: Greet",
    "",
    "**Description**: Add a greet function.",
    "**Files**: src/greet.ts",
    "",
    "## TKT-002: Farewell",
    "**Depends on**: TKT-001",
    "**Description**: Add farewell.",
  ].join("\n");
  const tickets = parseTickets(src);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].id, "TKT-001");
  assert.match(tickets[0].description!, /greet/i);
  assert.deepEqual(tickets[1].dependsOn, ["TKT-001"]);
});

test("parses markdown task list tickets", () => {
  const src = [
    "- [ ] TKT-001: Greet",
    "  details",
    "- [ ] TKT-002: Farewell",
  ].join("\n");
  const tickets = parseTickets(src);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].id, "TKT-001");
  assert.equal(tickets[1].title, "Farewell");
});

test("parses simple text tickets", () => {
  const tickets = parseTickets("TKT-001: Greet\nTKT-002: Farewell");
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].id, "TKT-001");
});

test("throws on unparseable input", () => {
  assert.throws(() => parseTickets("nothing useful here"));
});

test("validateTickets rejects duplicates, missing deps, self deps", () => {
  assert.throws(() => validateTickets([{ id: "A", title: "a", description: "", dependsOn: [] }, { id: "A", title: "a2", description: "", dependsOn: [] }]), /Duplicate/i);
  assert.throws(() => validateTickets([{ id: "A", title: "a", description: "", dependsOn: ["B"] }]), /non-existent/i);
  assert.throws(() => validateTickets([{ id: "A", title: "a", description: "", dependsOn: ["A"] }]), /itself/i);
});

test("topologicalSort orders dependencies first", () => {
  const tickets = [
    { id: "C", title: "c", description: "", dependsOn: ["A"] },
    { id: "A", title: "a", description: "", dependsOn: [] },
    { id: "B", title: "b", description: "", dependsOn: ["A"] },
  ];
  const order = topologicalSort(tickets);
  assert.deepEqual(order, ["A", "C", "B"]);
});

test("topologicalSort throws on circular dependencies", () => {
  const tickets = [
    { id: "A", title: "a", description: "", dependsOn: ["B"] },
    { id: "B", title: "b", description: "", dependsOn: ["A"] },
  ];
  assert.throws(() => topologicalSort(tickets), /circular/i);
});
