import { log } from "./log";
import { Settings } from "./settings";

export interface EnhancedPullConfig {
    enabled: boolean;
    concurrency: number;
    retries: number;
    keepMirrorTags: boolean;
    mirrorMap: Record<string, string[]>;
    mirrorSources: EnhancedPullMirrorSource[];
}

export interface EnhancedPullMirrorSource {
    id: string;
    name: string;
    registry: string;
    mirror: string;
    enabled: boolean;
    lastStatus?: "success" | "error";
    lastTestMs?: number;
    lastCheckedAt?: string;
    lastError?: string;
}

export async function getEnhancedPullConfig() : Promise<EnhancedPullConfig> {
    const enabled = parseBooleanValue(
        await Settings.get("enhancedPullEnabled"),
        parseBooleanValue(process.env.DOCKGE_ENHANCED_PULL_ENABLED, false)
    );
    const concurrency = parseIntegerValue(
        await Settings.get("enhancedPullConcurrency"),
        parseIntegerValue(process.env.DOCKGE_ENHANCED_PULL_CONCURRENCY, 2, 1),
        1
    );
    const retries = parseIntegerValue(
        await Settings.get("enhancedPullRetries"),
        parseIntegerValue(process.env.DOCKGE_ENHANCED_PULL_RETRIES, 1, 0),
        0
    );
    const keepMirrorTags = parseBooleanValue(
        await Settings.get("enhancedPullKeepMirrorTags"),
        parseBooleanValue(process.env.DOCKGE_ENHANCED_PULL_KEEP_MIRROR_TAGS, false)
    );
    const mirrorSources = normalizeMirrorSourceList(
        await Settings.get("enhancedPullMirrorSources"),
        await Settings.get("enhancedPullMirrors"),
    );
    const mirrorMap = parseMirrorMap(
        await Settings.get("enhancedPullMirrorMap"),
        mirrorSources,
    );

    return {
        enabled,
        concurrency,
        retries,
        keepMirrorTags,
        mirrorMap,
        mirrorSources,
    };
}

export function parseMirrorMap(mirrorMapValue : unknown, sourceValue : unknown) : Record<string, string[]> {
    const mirrorMap : Record<string, string[]> = {};
    const mirrorSources = normalizeMirrorSourceList(sourceValue);
    const groupedSourceMap = sourcesToMirrorMap(mirrorSources);
    const envDockerHubMirrors = normalizeMirrorList(process.env.DOCKGE_ENHANCED_PULL_MIRRORS);

    if (envDockerHubMirrors.length > 0) {
        mirrorMap["docker.io"] = envDockerHubMirrors;
    }

    Object.assign(mirrorMap, groupedSourceMap);

    if (mirrorSources.length === 0) {
        const dockerHubMirrors = normalizeMirrorList(sourceValue);

        if (dockerHubMirrors.length > 0) {
            mirrorMap["docker.io"] = dockerHubMirrors;
        }
    }

    const envMirrorMap = parseMirrorMapJSON(process.env.DOCKGE_ENHANCED_PULL_MIRROR_MAP);
    Object.assign(mirrorMap, envMirrorMap);

    if (typeof(mirrorMapValue) === "object" && mirrorMapValue !== null && !Array.isArray(mirrorMapValue)) {
        for (const [ registry, mirrorList ] of Object.entries(mirrorMapValue)) {
            mirrorMap[registry] = normalizeMirrorList(mirrorList);
        }
    } else if (typeof(mirrorMapValue) === "string" && mirrorMapValue.trim() !== "") {
        Object.assign(mirrorMap, parseMirrorMapJSON(mirrorMapValue));
    }

    for (const [ registry, mirrorList ] of Object.entries(mirrorMap)) {
        if (mirrorList.length === 0) {
            delete mirrorMap[registry];
            continue;
        }

        mirrorMap[registry] = mirrorList;
    }

    return mirrorMap;
}

export function normalizeMirrorSourceList(value : unknown, fallbackValue : unknown = undefined) : EnhancedPullMirrorSource[] {
    if (Array.isArray(value)) {
        return value
            .map((item, index) => normalizeMirrorSource(item, index))
            .filter((item) => item.mirror !== "");
    }

    const fallbackMirrors = normalizeMirrorList(value);

    if (fallbackMirrors.length > 0) {
        return fallbackMirrors.map((mirror, index) => createMirrorSource(mirror, index));
    }

    const legacyMirrors = normalizeMirrorList(fallbackValue);
    return legacyMirrors.map((mirror, index) => createMirrorSource(mirror, index));
}

export function normalizeMirrorList(value : unknown) : string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter((item) => item !== "");
    }

    if (typeof(value) !== "string") {
        return [];
    }

    return value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item !== "");
}

export function sourcesToMirrorMap(sourceList : EnhancedPullMirrorSource[]) : Record<string, string[]> {
    const mirrorMap : Record<string, string[]> = {};

    for (const source of sourceList) {
        if (!source.enabled || source.mirror.trim() === "") {
            continue;
        }

        if (!mirrorMap[source.registry]) {
            mirrorMap[source.registry] = [];
        }

        mirrorMap[source.registry].push(source.mirror.trim());
    }

    return mirrorMap;
}

export async function testMirrorSource(source : EnhancedPullMirrorSource, timeoutMs = 5000) : Promise<EnhancedPullMirrorSource> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(buildMirrorTestURL(source.mirror), {
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
                ...source,
                lastStatus: "success",
                lastTestMs: elapsedMs,
                lastCheckedAt: new Date().toISOString(),
                lastError: "",
            };
        }

        return {
            ...source,
            lastStatus: "error",
            lastTestMs: elapsedMs,
            lastCheckedAt: new Date().toISOString(),
            lastError: `HTTP ${response.status}`,
        };
    } catch (error) {
        return {
            ...source,
            lastStatus: "error",
            lastTestMs: undefined,
            lastCheckedAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : "Unknown error",
        };
    } finally {
        clearTimeout(timeout);
    }
}

function parseMirrorMapJSON(value : unknown) : Record<string, string[]> {
    if (typeof(value) !== "string" || value.trim() === "") {
        return {};
    }

    try {
        const parsedValue = JSON.parse(value) as Record<string, unknown>;
        const mirrorMap : Record<string, string[]> = {};

        for (const [ registry, mirrorList ] of Object.entries(parsedValue)) {
            mirrorMap[registry] = normalizeMirrorList(mirrorList);
        }

        return mirrorMap;
    } catch (error) {
        if (error instanceof Error) {
            log.error("enhancedPullConfig", `Failed to parse mirror map JSON: ${error.message}`);
        }
        return {};
    }
}

function parseBooleanValue(value : unknown, defaultValue : boolean) : boolean {
    if (typeof(value) === "boolean") {
        return value;
    }

    if (typeof(value) === "string") {
        return [ "1", "true", "yes", "on" ].includes(value.toLowerCase());
    }

    return defaultValue;
}

function parseIntegerValue(value : unknown, defaultValue : number, minValue : number) : number {
    if (typeof(value) === "number" && Number.isFinite(value)) {
        return Math.max(Math.trunc(value), minValue);
    }

    if (typeof(value) === "string" && value.trim() !== "") {
        const parsedValue = Number.parseInt(value, 10);

        if (!Number.isNaN(parsedValue)) {
            return Math.max(parsedValue, minValue);
        }
    }

    return defaultValue;
}

function createMirrorSource(mirror : string, index : number) : EnhancedPullMirrorSource {
    return {
        id: `source-${index + 1}`,
        name: `Source ${index + 1}`,
        registry: "docker.io",
        mirror: mirror.trim(),
        enabled: true,
    };
}

function normalizeMirrorSource(value : unknown, index : number) : EnhancedPullMirrorSource {
    if (typeof(value) === "object" && value !== null) {
        const source = value as Record<string, unknown>;

        return {
            id: typeof(source.id) === "string" && source.id !== "" ? source.id : `source-${index + 1}`,
            name: typeof(source.name) === "string" && source.name.trim() !== "" ? source.name.trim() : `Source ${index + 1}`,
            registry: typeof(source.registry) === "string" && source.registry.trim() !== "" ? source.registry.trim() : "docker.io",
            mirror: typeof(source.mirror) === "string" ? source.mirror.trim() : "",
            enabled: source.enabled !== false,
            lastStatus: source.lastStatus === "success" || source.lastStatus === "error" ? source.lastStatus : undefined,
            lastTestMs: typeof(source.lastTestMs) === "number" ? source.lastTestMs : undefined,
            lastCheckedAt: typeof(source.lastCheckedAt) === "string" ? source.lastCheckedAt : undefined,
            lastError: typeof(source.lastError) === "string" ? source.lastError : undefined,
        };
    }

    return createMirrorSource(String(value || ""), index);
}

function buildMirrorTestURL(mirror : string) : string {
    if (mirror.startsWith("http://") || mirror.startsWith("https://")) {
        return mirror.replace(/\/+$/, "") + "/v2/";
    }

    return `https://${mirror.replace(/\/+$/, "")}/v2/`;
}
