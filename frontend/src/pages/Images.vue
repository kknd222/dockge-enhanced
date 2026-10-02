<template>
    <div class="container-fluid p-4">
        <h2>{{ $t("imageManagement") }}</h2>
        <div class="d-flex gap-2 flex-wrap my-3">
            <select v-model="endpoint" class="form-select w-auto" @change="refresh">
                <option value="">{{ $t("currentEndpoint") }}</option>
                <option v-for="(agent, key) in $root.agentList" :key="key" :value="agentEndpoint(agent, key)">{{ agent.name || agent.url || key }}</option>
            </select>
            <input v-model="search" class="form-control w-auto" :placeholder="$t('searchImages')" />
            <label><input v-model="danglingOnly" type="checkbox" /> {{ $t("danglingOnly") }}</label>
            <button class="btn btn-primary" :disabled="busy" @click="refresh">{{ $t("refreshImages") }}</button>
            <button class="btn btn-danger" :disabled="busy" @click="cleanup">{{ $t("cleanupDangling") }}</button>
        </div>
        <div class="alert alert-info">{{ $t("imageLayerNotice") }}</div>
        <pre v-if="diskUsage" class="image-command">{{ diskUsage }}</pre>
        <div v-if="error" class="alert alert-danger">{{ error }}</div>
        <div v-if="message" class="alert alert-success">{{ message }}</div>
        <div class="table-responsive">
            <table class="table table-hover">
                <thead><tr><th>ID / {{ $t("imageTags") }}</th><th>{{ $t("imageSize") }}</th><th>{{ $t("imageCreated") }}</th><th>{{ $t("imageLayers") }}</th><th>{{ $t("imageUsage") }}</th><th>{{ $t("imageActions") }}</th></tr></thead>
                <tbody>
                    <tr v-for="image in filtered" :key="image.id">
                        <td><code>{{ image.id.slice(7, 19) }}</code><span v-if="image.dangling" class="badge bg-warning ms-2">dangling</span><div v-for="imageTag in image.tags" :key="imageTag">{{ imageTag }}</div><small>{{ image.architecture }}</small></td>
                        <td>{{ size(image.size) }}</td><td>{{ new Date(image.created).toLocaleString() }}</td><td>{{ image.layers.length }}</td>
                        <td><div v-for="container in image.containers" :key="container.id">{{ container.name }} ({{ container.status }})</div></td>
                        <td class="text-nowrap">
                            <button class="btn btn-sm btn-normal me-1" :disabled="busy" @click="details(image)">{{ $t("imageDetails") }}</button>
                            <button class="btn btn-sm btn-normal me-1" :disabled="busy" @click="tag(image)">Tag</button>
                            <button class="btn btn-sm btn-danger" :disabled="busy || image.containers.length > 0" @click="remove(image)">{{ $t("deleteImage") }}</button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <section v-if="detail" class="shadow-box p-3">
            <button class="btn btn-normal float-end" @click="detail = null">{{ $t("closeImageDetails") }}</button>
            <h3>{{ $t("imageLayers") }}</h3>
            <p>{{ detail.image.Id }}</p>
            <ol><li v-for="layer in detail.image.RootFS?.Layers || []" :key="layer"><code>{{ layer }}</code></li></ol>
            <h4>{{ $t("imageHistory") }}</h4>
            <div v-for="(row, index) in detail.history" :key="index" class="mb-2"><strong>{{ row.Size }}</strong><pre class="image-command">{{ row.CreatedBy }}</pre></div>
        </section>
    </div>
</template>

<script>
export default {
    data() {
        return { endpoint: "",
            images: [],
            diskUsage: "",
            detail: null,
            search: "",
            danglingOnly: false,
            busy: false,
            error: "",
            message: "" };
    },
    computed: {
        filtered() {
            const query = this.search.toLowerCase();
            return this.images.filter(image => (!this.danglingOnly || image.dangling) && [ image.id, ...image.tags ].some(text => text.toLowerCase().includes(query)));
        },
    },
    mounted() {
        this.refresh();
    },
    methods: {
        agentEndpoint(agent, key) {
            try {
                return agent.url ? new URL(agent.url).host : key;
            } catch {
                return key;
            }
        },
        size(bytes) {
            return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        },
        call(event, ...args) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(this.$t("imageRequestTimeout"))), 130000);
                this.$root.emitAgent(this.endpoint, event, ...args, res => {
                    clearTimeout(timer);
                    if (res.ok) {
                        resolve(res.result);
                    } else {
                        reject(new Error(res.msg));
                    }
                });
            });
        },
        async action(handler) {
            this.busy = true;
            this.error = "";
            this.message = "";
            try {
                await handler();
            } catch (error) {
                this.error = error.message;
            } finally {
                this.busy = false;
            }
        },
        refresh() {
            this.detail = null;
            return this.action(async () => {
                this.images = await this.call("listDockerImages");
                this.diskUsage = await this.call("dockerImageDiskUsage");
            });
        },
        details(image) {
            return this.action(async () => {
                this.detail = await this.call("inspectDockerImage", image.id);
            });
        },
        remove(image) {
            if (!window.confirm(`${this.$t("deleteImagePrompt")}\n${image.id}\n${image.tags.join("\n")}`)) {
                return;
            }
            return this.action(async () => {
                this.message = await this.call("removeDockerImage", image.id);
                this.images = await this.call("listDockerImages");
                this.diskUsage = await this.call("dockerImageDiskUsage");
                this.detail = null;
            });
        },
        tag(image) {
            const tag = window.prompt(this.$t("newImageTag"));
            if (!tag) {
                return;
            }
            return this.action(async () => {
                await this.call("tagDockerImage", image.id, tag);
                this.images = await this.call("listDockerImages");
                this.diskUsage = await this.call("dockerImageDiskUsage");
            });
        },
        cleanup() {
            if (!window.confirm(this.$t("cleanupDanglingPrompt"))) {
                return;
            }
            return this.action(async () => {
                const result = await this.call("cleanupDanglingImages");
                this.message = `${this.$t("cleanupResult")}: ${result.removed.length} / ${result.skipped.length}`;
                this.images = await this.call("listDockerImages");
                this.diskUsage = await this.call("dockerImageDiskUsage");
            });
        },
    },
};
</script>

<style scoped>
.image-command { white-space: pre-wrap; overflow-wrap: anywhere; }
code { overflow-wrap: anywhere; }
</style>
