<template>
    <div v-if="settingsLoaded">
        <form class="my-4" autocomplete="off" @submit.prevent="saveImagePullSettings">
            <div class="form-check mb-4">
                <input
                    id="enhanced-pull-enabled"
                    v-model="settings.enhancedPullEnabled"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="enhanced-pull-enabled">
                    {{ $t("enhancedPullEnabled") }}
                </label>
                <div class="form-text">
                    {{ $t("enhancedPullEnabledDescription") }}
                </div>
            </div>

            <div class="row">
                <div class="col-lg-6 mb-4">
                    <label class="form-label" for="enhanced-pull-concurrency">
                        {{ $t("enhancedPullConcurrency") }}
                    </label>
                    <input
                        id="enhanced-pull-concurrency"
                        v-model.number="settings.enhancedPullConcurrency"
                        class="form-control"
                        min="1"
                        step="1"
                        type="number"
                    />
                    <div class="form-text">
                        {{ $t("enhancedPullConcurrencyDescription") }}
                    </div>
                </div>

                <div class="col-lg-6 mb-4">
                    <label class="form-label" for="enhanced-pull-retries">
                        {{ $t("enhancedPullRetries") }}
                    </label>
                    <input
                        id="enhanced-pull-retries"
                        v-model.number="settings.enhancedPullRetries"
                        class="form-control"
                        min="0"
                        step="1"
                        type="number"
                    />
                    <div class="form-text">
                        {{ $t("enhancedPullRetriesDescription") }}
                    </div>
                </div>
            </div>

            <div class="form-check mb-4">
                <input
                    id="enhanced-pull-keep-mirror-tags"
                    v-model="settings.enhancedPullKeepMirrorTags"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="enhanced-pull-keep-mirror-tags">
                    {{ $t("enhancedPullKeepMirrorTags") }}
                </label>
                <div class="form-text">
                    {{ $t("enhancedPullKeepMirrorTagsDescription") }}
                </div>
            </div>

            <div class="shadow-box big-padding mb-4">
                <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                    <div>
                        <h5 class="mb-1">{{ $t("enhancedPullSourceManager") }}</h5>
                        <div class="form-text">
                            {{ $t("enhancedPullSourceManagerDescription") }}
                        </div>
                    </div>

                    <div class="d-flex flex-wrap gap-2">
                        <button class="btn btn-normal btn-sm" type="button" :disabled="testingSources" @click="addMirrorSource">
                            {{ $t("enhancedPullAddSource") }}
                        </button>
                        <button class="btn btn-outline-primary btn-sm" type="button" :disabled="testingSources || sourceList.length === 0" @click="testMirrorSources(false)">
                            {{ $t("enhancedPullTestAllSources") }}
                        </button>
                        <button class="btn btn-primary btn-sm" type="button" :disabled="testingSources || sourceList.length === 0" @click="testMirrorSources(true)">
                            {{ $t("enhancedPullFindFastestSource") }}
                        </button>
                    </div>
                </div>

                <div v-if="sourceList.length === 0" class="text-muted">
                    {{ $t("enhancedPullNoSources") }}
                </div>

                <div v-for="(source, index) in sourceList" :key="source.id || index" class="border rounded p-3 mb-3">
                    <div class="row g-3 align-items-start">
                        <div class="col-lg-3">
                            <label class="form-label">{{ $t("enhancedPullSourceName") }}</label>
                            <input v-model="source.name" class="form-control" :placeholder="$t('enhancedPullSourceNamePlaceholder')" />
                        </div>

                        <div class="col-lg-3">
                            <label class="form-label">{{ $t("registry") }}</label>
                            <input v-model="source.registry" class="form-control" placeholder="docker.io" />
                        </div>

                        <div class="col-lg-4">
                            <label class="form-label">{{ $t("enhancedPullSourceAddress") }}</label>
                            <input v-model="source.mirror" class="form-control font-monospace" :placeholder="$t('enhancedPullSourceAddressPlaceholder')" />
                        </div>

                        <div class="col-lg-2">
                            <label class="form-label d-block">{{ $t("Status") }}</label>
                            <span class="badge" :class="sourceStatusClass(source)">
                                {{ sourceStatusText(source) }}
                            </span>
                            <div v-if="source.lastTestMs" class="small text-muted mt-1">
                                {{ source.lastTestMs }} ms
                            </div>
                        </div>
                    </div>

                    <div class="d-flex flex-wrap align-items-center gap-2 mt-3">
                        <div class="form-check me-2">
                            <input :id="`source-enabled-${index}`" v-model="source.enabled" class="form-check-input" type="checkbox" />
                            <label class="form-check-label" :for="`source-enabled-${index}`">
                                {{ $t("enabled") }}
                            </label>
                        </div>

                        <button class="btn btn-outline-primary btn-sm" type="button" :disabled="testingSources || !source.mirror" @click="testSingleSource(index)">
                            {{ $t("enhancedPullTestSource") }}
                        </button>
                        <button class="btn btn-normal btn-sm" type="button" :disabled="index === 0" @click="moveSource(index, -1)">
                            {{ $t("Move Up") }}
                        </button>
                        <button class="btn btn-normal btn-sm" type="button" :disabled="index === sourceList.length - 1" @click="moveSource(index, 1)">
                            {{ $t("Move Down") }}
                        </button>
                        <button class="btn btn-outline-danger btn-sm" type="button" @click="removeMirrorSource(index)">
                            {{ $t("deleteContainer") }}
                        </button>
                    </div>

                    <div v-if="source.lastError" class="small text-danger mt-2">
                        {{ source.lastError }}
                    </div>
                    <div v-if="source.lastCheckedAt" class="small text-muted mt-1">
                        {{ $t("enhancedPullLastChecked") }}: {{ formatDateTime(source.lastCheckedAt) }}
                    </div>
                </div>
            </div>

            <div class="mb-4">
                <label class="form-label" for="enhanced-pull-mirror-map">
                    {{ $t("enhancedPullMirrorMap") }}
                </label>
                <textarea
                    id="enhanced-pull-mirror-map"
                    v-model="settings.enhancedPullMirrorMapText"
                    class="form-control font-monospace"
                    rows="6"
                    placeholder="{&quot;ghcr.io&quot;:[&quot;ghcr.nju.edu.cn&quot;]}"
                ></textarea>
                <div class="form-text">
                    {{ $t("enhancedPullMirrorMapDescription") }}
                </div>
            </div>

            <div class="alert alert-secondary" role="alert">
                <div class="fw-bold mb-2">
                    {{ $t("enhancedPullLogPreview") }}
                </div>
                <code class="d-block">
                    [enhanced-pull] Candidates for nginx:latest: docker.m.daocloud.io/library/nginx:latest -> nginx:latest
                </code>
                <code class="d-block">
                    [enhanced-pull] Pulling nginx:latest via docker.m.daocloud.io/library/nginx:latest (attempt 1/3)
                </code>
                <code class="d-block">
                    [enhanced-pull] Retagging docker.m.daocloud.io/library/nginx:latest back to nginx:latest
                </code>
            </div>

            <div>
                <button class="btn btn-primary" type="submit" :disabled="testingSources">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>
export default {
    data() {
        return {
            testingSources: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        sourceList() {
            if (!Array.isArray(this.settings.enhancedPullMirrorSources)) {
                this.settings.enhancedPullMirrorSources = [];
            }

            return this.settings.enhancedPullMirrorSources;
        },
    },

    methods: {
        saveImagePullSettings() {
            this.settings.enhancedPullMirrors = this.sourceList
                .filter((source) => source.registry === "docker.io")
                .map((source) => source.mirror)
                .join("\n");
            this.saveSettings();
        },

        addMirrorSource() {
            const nextIndex = this.sourceList.length + 1;
            this.sourceList.push({
                id: `source-${Date.now()}-${nextIndex}`,
                name: `${this.$t("enhancedPullSource")} ${nextIndex}`,
                registry: "docker.io",
                mirror: "",
                enabled: true,
            });
        },

        removeMirrorSource(index) {
            this.sourceList.splice(index, 1);
        },

        moveSource(index, direction) {
            const targetIndex = index + direction;

            if (targetIndex < 0 || targetIndex >= this.sourceList.length) {
                return;
            }

            const source = this.sourceList.splice(index, 1)[0];
            this.sourceList.splice(targetIndex, 0, source);
        },

        async testSingleSource(index) {
            await this.testMirrorSources(false, index);
        },

        async testMirrorSources(sortFastest, singleIndex = null) {
            this.testingSources = true;

            const sourceList = singleIndex === null ? this.sourceList : [ this.sourceList[singleIndex] ];

            this.$root.getSocket().emit("testImagePullSources", sourceList, sortFastest, (res) => {
                this.testingSources = false;

                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }

                if (singleIndex === null) {
                    this.settings.enhancedPullMirrorSources = res.sourceList;
                } else {
                    this.settings.enhancedPullMirrorSources.splice(singleIndex, 1, res.sourceList[0]);
                }

                this.saveImagePullSettings();

                if (res.fastestSource && sortFastest) {
                    this.$root.toastRes({
                        ok: true,
                        msg: `${this.$t("enhancedPullFastestSource")}: ${res.fastestSource.name} (${res.fastestSource.lastTestMs} ms)`,
                    });
                }
            });
        },

        sourceStatusText(source) {
            if (source.lastStatus === "success") {
                return this.$t("agentOnline");
            }

            if (source.lastStatus === "error") {
                return this.$t("agentOffline");
            }

            return this.$t("notAvailableShort");
        },

        sourceStatusClass(source) {
            if (source.lastStatus === "success") {
                return "bg-primary";
            }

            if (source.lastStatus === "error") {
                return "bg-danger";
            }

            return "bg-secondary";
        },

        formatDateTime(value) {
            if (!value) {
                return "";
            }

            return new Date(value).toLocaleString();
        },
    },
};
</script>
