import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

interface PullConfig {
    concurrency: number;
    retries: number;
    keepMirrorTags: boolean;
    mirrorMap: Record<string, string[]>;
    images: string[];
}

interface ImageReference {
    original: string;
    registry: string;
    repository: string;
    suffix: string;
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
let isStopping = false;

process.on("SIGINT", () => {
    if (isStopping) {
        return;
    }

    isStopping = true;
    console.log("[enhanced-pull] Cancellation requested, stopping active docker pull processes...");

    for (const child of activeChildren) {
        child.kill("SIGINT");
    }

    setTimeout(() => {
        for (const child of activeChildren) {
            if (!child.killed) {
                child.kill("SIGTERM");
            }
        }
    }, 5000).unref();
});

async function main() {
    const config = parseArgs(process.argv.slice(2));

    if (config.images.length === 0) {
        console.log("[enhanced-pull] No images to pull.");
        return;
    }

    console.log(`[enhanced-pull] Pull mode enabled. images=${config.images.length}, concurrency=${config.concurrency}, retries=${config.retries}`);

    const queue = [ ...config.images ];
    const workers = Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            if (isStopping) {
                throw new Error("Pull cancelled");
            }

            const image = queue.shift();

            if (!image) {
                return;
            }

            await pullImage(image, config);
        }
    });

    await Promise.all(workers);
    console.log("[enhanced-pull] All images pulled successfully.");
}

async function pullImage(image : string, config : PullConfig) {
    const imageReference = parseImageReference(image);
    const candidateImages = buildCandidateImages(imageReference, config.mirrorMap);
    const maxAttempts = Math.max(config.retries + 1, 1);

    console.log(`[enhanced-pull] Candidates for ${image}: ${candidateImages.join(" -> ")}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        for (const candidateImage of candidateImages) {
            if (isStopping) {
                throw new Error("Pull cancelled");
            }

            console.log(`[enhanced-pull] Pulling ${image} via ${candidateImage} (attempt ${attempt}/${maxAttempts})`);
            const pullExitCode = await runDockerCommand([ "pull", candidateImage ], image);

            if (pullExitCode !== 0) {
                console.log(`[enhanced-pull] Pull failed for ${candidateImage}`);
                continue;
            }

            if (candidateImage !== image) {
                console.log(`[enhanced-pull] Retagging ${candidateImage} back to ${image}`);
                const tagExitCode = await runDockerCommand([ "image", "tag", candidateImage, image ], image);

                if (tagExitCode !== 0) {
                    console.log(`[enhanced-pull] Tagging ${candidateImage} back to ${image} failed.`);
                    continue;
                }

                if (!config.keepMirrorTags) {
                    console.log(`[enhanced-pull] Removing temporary mirror tag ${candidateImage}`);
                    await runDockerCommand([ "image", "rm", candidateImage ], image, true);
                }
            }

            console.log(`[enhanced-pull] Pull completed for ${image}`);
            return;
        }
    }

    throw new Error(`All pull attempts failed for ${image}`);
}

function parseArgs(args : string[]) : PullConfig {
    const config : PullConfig = {
        concurrency: 2,
        retries: 1,
        keepMirrorTags: false,
        mirrorMap: {},
        images: [],
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--concurrency") {
            config.concurrency = Number.parseInt(args[++i] || "2", 10);
        } else if (arg === "--retries") {
            config.retries = Number.parseInt(args[++i] || "1", 10);
        } else if (arg === "--mirror-map-json") {
            const mirrorMapJSON = args[++i] || "{}";
            config.mirrorMap = JSON.parse(mirrorMapJSON) as Record<string, string[]>;
        } else if (arg === "--keep-mirror-tags") {
            config.keepMirrorTags = true;
        } else if (arg === "--image") {
            const image = args[++i];

            if (image) {
                config.images.push(image);
            }
        }
    }

    config.concurrency = Number.isNaN(config.concurrency) ? 2 : Math.max(config.concurrency, 1);
    config.retries = Number.isNaN(config.retries) ? 1 : Math.max(config.retries, 0);

    return config;
}

function parseImageReference(image : string) : ImageReference {
    const digestIndex = image.indexOf("@");
    let imageWithoutDigest = image;
    let suffix = "";

    if (digestIndex !== -1) {
        imageWithoutDigest = image.slice(0, digestIndex);
        suffix = image.slice(digestIndex);
    }

    const lastSlashIndex = imageWithoutDigest.lastIndexOf("/");
    const lastColonIndex = imageWithoutDigest.lastIndexOf(":");

    if (lastColonIndex > lastSlashIndex) {
        suffix = imageWithoutDigest.slice(lastColonIndex) + suffix;
        imageWithoutDigest = imageWithoutDigest.slice(0, lastColonIndex);
    }

    const parts = imageWithoutDigest.split("/");
    const firstPart = parts[0];
    const hasExplicitRegistry = firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost";
    const registry = hasExplicitRegistry ? firstPart : "docker.io";
    let repository = hasExplicitRegistry ? parts.slice(1).join("/") : parts.join("/");

    if (!repository.includes("/")) {
        repository = `library/${repository}`;
    }

    return {
        original: image,
        registry,
        repository,
        suffix,
    };
}

function buildCandidateImages(imageReference : ImageReference, mirrorMap : Record<string, string[]>) : string[] {
    const candidates = new Set<string>();
    const mirrors = mirrorMap[imageReference.registry] || [];

    for (const mirror of mirrors) {
        const normalizedMirror = mirror.trim().replace(/\/+$/, "");

        if (normalizedMirror !== "") {
            candidates.add(`${normalizedMirror}/${imageReference.repository}${imageReference.suffix}`);
        }
    }

    candidates.add(imageReference.original);
    return Array.from(candidates);
}

async function runDockerCommand(args : string[], image : string, allowFailure = false) : Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
            stdio: [ "ignore", "pipe", "pipe" ],
        });

        activeChildren.add(child);
        pipeOutput(child.stdout, image);
        pipeOutput(child.stderr, image);

        child.on("error", (error) => {
            activeChildren.delete(child);

            if (allowFailure) {
                console.log(`[${image}] ${error.message}`);
                resolve(1);
                return;
            }

            reject(error);
        });

        child.on("close", (code) => {
            activeChildren.delete(child);

            if (code === 0 || allowFailure) {
                resolve(code ?? 0);
                return;
            }

            resolve(code ?? 1);
        });
    });
}

function pipeOutput(stream : NodeJS.ReadableStream, image : string) {
    let buffer = "";

    stream.on("data", (chunk : Buffer | string) => {
        buffer += chunk.toString();

        while (buffer.includes("\n")) {
            const newLineIndex = buffer.indexOf("\n");
            const line = buffer.slice(0, newLineIndex).replace(/\r$/, "");
            buffer = buffer.slice(newLineIndex + 1);
            console.log(`[${image}] ${line}`);
        }
    });

    stream.on("end", () => {
        if (buffer.trim() !== "") {
            console.log(`[${image}] ${buffer.trimEnd()}`);
        }
    });
}

main().catch((error) => {
    if (error instanceof Error) {
        console.error(`[enhanced-pull] ${error.message}`);
    } else {
        console.error("[enhanced-pull] Unknown error");
    }

    process.exit(1);
});
