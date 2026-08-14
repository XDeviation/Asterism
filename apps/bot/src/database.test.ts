import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BotDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

function database(): BotDatabase {
  const directory = mkdtempSync(join(tmpdir(), "asterism-bot-test-"));
  temporaryDirectories.push(directory);
  return new BotDatabase(join(directory, "database.sqlite"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("BotDatabase outbox", () => {
  it("coalesces repeated message state without changing queue order", () => {
    const db = database();
    db.enqueue("message:1", "PUT", "/messages", { content: "old" });
    db.enqueue("delete:1", "DELETE", "/messages/1");
    db.enqueue("message:1", "PUT", "/messages", { content: "new" });

    const first = db.nextOutboxItem();
    expect(first?.method).toBe("PUT");
    expect(first?.body).toEqual({ content: "new" });
    db.completeOutboxItem(first!.id);
    expect(db.nextOutboxItem()?.method).toBe("DELETE");
    db.close();
  });

  it("blocks later events while the first event is backing off", () => {
    const db = database();
    db.enqueue("first", "PUT", "/first", {});
    db.enqueue("second", "PUT", "/second", {});
    const first = db.nextOutboxItem()!;
    db.retryOutboxItem(first.id, 1);
    expect(db.nextOutboxItem()).toBeNull();
    db.close();
  });
});

