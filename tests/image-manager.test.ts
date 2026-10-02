import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageManager } from "../backend/image-manager";

const id = "sha256:" + "a".repeat(64);
const other = "sha256:" + "b".repeat(64);
function fixture(options: { used?: boolean; tagged?: boolean; dangling?: boolean } = {}) {
    const commands: string[][] = [];
    const manager = new ImageManager(async (args) => {
        commands.push(args);
        if (args[0] === "ps") {
            return options.used ? "container1\n" : "";
        }
        if (args[0] === "inspect") {
            return JSON.stringify([{ Id: "container1",
                Image: id,
                Name: "/stopped",
                State: { Status: "exited" } }]);
        }
        if (args[1] === "inspect") {
            return JSON.stringify([{ Id: args[2] === other ? other : id,
                RepoTags: options.tagged ? [ "nginx:latest" ] : [],
                RepoDigests: [],
                RootFS: { Layers: [ other ] },
                Size: 123,
                Created: "2026-10-02",
                Architecture: "amd64" }]);
        }
        if (args[1] === "ls") {
            return args.includes("--filter") ? (options.dangling === false ? "" : id + "\n") : id + "\n" + id + "\n";
        }
        if (args[1] === "history") {
            return JSON.stringify({ Size: "123B",
                CreatedBy: "COPY file" }) + "\n";
        }
        return "Deleted: " + args[2];
    });
    return { manager,
        commands };
}

test("listing deduplicates images and exposes layers and stopped container usage", async () => {
    const { manager } = fixture({ used: true });
    const result = await manager.list();
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].layers, [ other ]);
    assert.equal(result[0].containers[0].status, "exited");
});
test("deletion protects running and stopped container references", async () => {
    const { manager, commands } = fixture({ used: true });
    await assert.rejects(manager.remove(id), /referenced/);
    assert.ok(!commands.some(args => args[1] === "rm"));
});
test("cleanup never removes tagged images", async () => {
    const { manager } = fixture({ tagged: true });
    const result = await manager.cleanupCandidates([ id ]);
    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 1);
});
test("cleanup checks Docker dangling filter and removes only supplied IDs without force", async () => {
    const { manager, commands } = fixture();
    const result = await manager.cleanupCandidates([ id, id ]);
    assert.deepEqual(result.removed, [ id ]);
    assert.deepEqual(commands.filter(args => args[1] === "rm"), [[ "image", "rm", id ]]);
    assert.ok(!commands.some(args => args.includes("prune") || args.includes("--force")));
});
test("non-dangling images are preserved", async () => {
    const { manager } = fixture({ dangling: false });
    assert.equal((await manager.cleanupCandidates([ id ])).removed.length, 0);
});
test("invalid IDs cannot become Docker arguments", async () => {
    const { manager, commands } = fixture();
    await assert.rejects(manager.remove("--force"));
    assert.equal(commands.length, 0);
});
test("tags already in use are not overwritten", async () => {
    const { manager } = fixture();
    await assert.rejects(manager.tag(id, "nginx:latest"), /already exists/);
    await assert.rejects(manager.tag(id, "--help"), /Invalid/);
});
test("details include build history", async () => {
    const { manager } = fixture();
    assert.equal((await manager.details(id)).history[0].CreatedBy, "COPY file");
});
