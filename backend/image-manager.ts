import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type DockerRunner = (args: string[]) => Promise<string>;
const runDocker: DockerRunner = async (args) => {
    const result = await exec("docker", args, { encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000 });
    return result.stdout;
};

export class ImageManager {
    constructor(private run: DockerRunner = runDocker) {}

    validateID(id: unknown): string {
        if (typeof id !== "string" || !/^(sha256:)?[a-f0-9]{12,64}$/.test(id)) {
            throw new Error("Expected a Docker image ID");
        }
        return id;
    }

    async inspect(id: string) {
        return JSON.parse(await this.run([ "image", "inspect", id ]))[0];
    }

    async containerUsage() {
        const ids = (await this.run([ "ps", "-aq", "--no-trunc" ])).trim().split(/\s+/).filter(Boolean);
        if (!ids.length) {
            return [];
        }
        const containers = JSON.parse(await this.run([ "inspect", ...ids ]));
        return containers.map((c: { Id: string; Image: string; Name: string; State: { Status: string } }) => ({
            id: c.Id,
            image: c.Image,
            name: c.Name.replace(/^\//, ""),
            status: c.State.Status,
        }));
    }

    async list() {
        const ids = Array.from(new Set((await this.run([ "image", "ls", "-aq", "--no-trunc" ])).trim().split(/\s+/).filter(Boolean)));
        const usage = await this.containerUsage();
        const danglingIDs = new Set((await this.run([ "image", "ls", "-q", "--no-trunc", "--filter", "dangling=true" ])).trim().split(/\s+/));
        if (!ids.length) {
            return [];
        }
        const images = JSON.parse(await this.run([ "image", "inspect", ...ids ]));
        return images.map((image: { Id: string; RepoTags?: string[]; RepoDigests?: string[]; Size: number; Created: string; Architecture: string; RootFS?: { Layers?: string[] } }) => ({
            id: image.Id,
            tags: image.RepoTags || [],
            digests: image.RepoDigests || [],
            size: image.Size,
            created: image.Created,
            architecture: image.Architecture,
            layers: image.RootFS?.Layers || [],
            dangling: danglingIDs.has(image.Id),
            containers: usage.filter((c: { image: string }) => c.image === image.Id),
        }));
    }

    async diskUsage() {
        return this.run([ "system", "df" ]);
    }

    async details(id: unknown) {
        const valid = this.validateID(id);
        const image = await this.inspect(valid);
        const history = (await this.run([ "image", "history", "--no-trunc", "--format", "{{json .}}", valid ])).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        return { image,
            history };
    }

    async remove(id: unknown, danglingOnly = false) {
        const valid = this.validateID(id);
        const image = await this.inspect(valid);
        if ((await this.containerUsage()).some((c: { image: string }) => c.image === image.Id)) {
            throw new Error("Image is referenced by a running or stopped container");
        }
        if (danglingOnly && (image.RepoTags?.length || !(await this.run([ "image", "ls", "-q", "--no-trunc", "--filter", "dangling=true" ])).split(/\s+/).includes(image.Id))) {
            throw new Error("Image is not dangling");
        }
        // No force: Docker rechecks references and protects shared layers.
        return this.run([ "image", "rm", image.Id ]);
    }

    async tag(id: unknown, tag: unknown) {
        const valid = this.validateID(id);
        if (typeof tag !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(tag) || tag.length > 255) {
            throw new Error("Invalid image tag");
        }
        try {
            await this.inspect(tag);
        } catch {
            return this.run([ "image", "tag", valid, tag ]);
        }
        throw new Error("Tag already exists; choose a new tag");
    }

    async capture(references: string[]) {
        const ids: string[] = [];
        for (const ref of references) {
            try {
                ids.push((await this.inspect(ref)).Id);
            } catch { /* New image has no previous local version. */ }
        }
        return Array.from(new Set(ids));
    }

    async cleanupCandidates(ids: string[]) {
        const removed: string[] = [];
        const skipped: { id: string; reason: string }[] = [];
        for (const id of Array.from(new Set(ids))) {
            try {
                await this.remove(id, true);
                removed.push(id);
            } catch (error) {
                skipped.push({ id,
                    reason: error instanceof Error ? error.message : String(error) });
            }
        }
        return { removed,
            skipped };
    }
}
