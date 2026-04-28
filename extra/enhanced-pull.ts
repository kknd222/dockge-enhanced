import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const MIRROR_PROBE_TIMEOUT_MS = 3000;
const PULL_TIMEOUT_MS = 90000;
const MAX_MIRROR_ATTEMPTS = 2;

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
    const candidateImages = await buildCandidateImages(imageReference, config.mirrorMap);
    const maxAttempts = Math.max(config.retries + 1, 1);
    const mirrorCandidates = candidateImages.filter((candidateImage) => candidateImage !== image);
    const directCandidates = candidateImages.filter((candidateImage) => candidateImage === image);
    const mirrorAttempts = Math.min(maxAttempts, MAX_MIRROR_ATTEMPTS);
    const directAttempts = Math.max(1, maxAttempts - mirrorAttempts);

    console.log(`[enhanced-pull] Candidates for ${image}: ${candidateImages.join(" -> ")}`);

    for (const candidateImage of mirrorCandidates) {
        await tryPullCandidate(image, candidateImage, mirrorAttempts);
    }

    for (const candidateImage of directCandidates) {
        await tryPullCandidate(image, candidateImage, directAttempts);
    }

    throw new Error(`All pull attempts failed for ${image}`);

    async function tryPullCandidate(originalImage : string, candidateImage : string, allowedAttempts : number) {
        if (allowedAttempts <= 0) {
            return;
        }

        for (let attempt = 1; attempt <= allowedAttempts; attempt++) {
            if (isStopping) {
                throw new Error("Pull cancelled");
            }

            console.log(`[enhanced-pull] Pulling ${originalImage} via ${candidateImage} (attempt ${attempt}/${allowedAttempts})`);
            const pullExitCode = await runDockerCommand([ "pull", candidateImage ], originalImage, false, PULL_TIMEOUT_MS);

            if (pullExitCode !== 0) {
                console.log(`[enhanced-pull] Pull failed for ${candidateImage}`);
                continue;
            }

            if (candidateImage !== originalImage) {
                console.log(`[enhanced-pull] Retagging ${candidateImage} back to ${originalImage}`);
                const tagExitCode = await runDockerCommand([ "image", "tag", candidateImage, originalImage ], originalImage);

                if (tagExitCode !== 0) {
                    console.log(`[enhanced-pull] Tagging ${candidateImage} back to ${originalImage} failed.`);
                    continue;
                }

                if (!config.keepMirrorTags) {
                    console.log(`[enhanced-pull] Removing temporary mirror tag ${candidateImage}`);
                    await runDockerCommand([ "image", "rm", candidateImage ], originalImage, true);
                }
            }

            console.log(`[enhanced-pull] Pull completed for ${originalImage}`);
            process.exitCode = 0;
            throw new SuccessSignal();
        }
    }
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

async function buildCandidateImages(imageReference : ImageReference, mirrorMap : Record<string, string[]>) : Promise<string[]> {
    const candidates = new Set<string>();
    const mirrors = mirrorMap[imageReference.registry] || [];
    const availableMirrors : string[] = [];

    for (const mirror of mirrors) {
        const normalizedMirror = mirror.trim().replace(/\/+$/, "");

        if (normalizedMirror !== "") {
            const probeResult = await probeMirror(normalizedMirror);

            if (probeResult.ok) {
                console.log(`[enhanced-pull] Mirror probe OK for ${normalizedMirror} (${probeResult.elapsedMs} ms)`);
                availableMirrors.push(normalizedMirror);
            } else {
                console.log(`[enhanced-pull] Mirror probe failed for ${normalizedMirror}: ${probeResult.error}`);
            }
        }
    }

    for (const mirror of availableMirrors) {
        candidates.add(`${mirror}/${imageReference.repository}${imageReference.suffix}`);
    }

    candidates.add(imageReference.original);
    return Array.from(candidates);
}

async function runDockerCommand(args : string[], image : string, allowFailure = false, timeoutMs = 0) : Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
            stdio: [ "ignore", "pipe", "pipe" ],
        });
        let timedOut = false;
        let timeout : NodeJS.Timeout | undefined;

        activeChildren.add(child);
        pipeOutput(child.stdout, image);
        pipeOutput(child.stderr, image);

        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                timedOut = true;
                console.log(`[${image}] Command timed out after ${timeoutMs} ms: docker ${args.join(" ")}`);
                child.kill("SIGINT");

                setTimeout(() => {
                    if (!child.killed) {
                        child.kill("SIGTERM");
                    }
                }, 5000).unref();
            }, timeoutMs);
        }

        child.on("error", (error) => {
            activeChildren.delete(child);
            clearTimeout(timeout);

            if (allowFailure) {
                console.log(`[${image}] ${error.message}`);
                resolve(1);
                return;
            }

            reject(error);
        });

        child.on("close", (code) => {
            activeChildren.delete(child);
            clearTimeout(timeout);

            if (timedOut) {
                resolve(124);
                return;
            }

            if (code === 0 || allowFailure) {
                resolve(code ?? 0);
                return;
            }

            resolve(code ?? 1);
        });
    });
}

async function probeMirror(mirror : string) : Promise<{ ok: boolean, elapsedMs: number, error: string }> {
    const controller = new AbortController();
    const startTime = Date.now();
    const timeout = setTimeout(() => {
        controller.abort();
    }, MIRROR_PROBE_TIMEOUT_MS);

    try {
        const response = await fetch(buildMirrorTestURL(mirror), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
                Accept: "application/json",
            },
        });
        const elapsedMs = Date.now() - startTime;

        if ([ 200, 401 ].includes(response.status)) {
            return {
                ok: true,
                elapsedMs,
                error: "",
            };
        }

        return {
            ok: false,
            elapsedMs,
            error: `HTTP ${response.status}`,
        };
    } catch (error) {
        return {
            ok: false,
            elapsedMs: Date.now() - startTime,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    } finally {
        clearTimeout(timeout);
    }
}

function buildMirrorTestURL(mirror : string) : string {
    if (mirror.startsWith("http://") || mirror.startsWith("https://")) {
        return mirror.replace(/\/+$/, "") + "/v2/";
    }

    return `https://${mirror.replace(/\/+$/, "")}/v2/`;
}

class SuccessSignal extends Error {}

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
    if (error instanceof SuccessSignal) {
        process.exit(0);
    }

    if (error instanceof Error) {
        console.error(`[enhanced-pull] ${error.message}`);
    } else {
        console.error("[enhanced-pull] Unknown error");
    }

    process.exit(1);
});
