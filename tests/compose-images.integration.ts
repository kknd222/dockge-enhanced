import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Stack } from "../backend/stack";
import type { DockgeServer } from "../backend/dockge-server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-compose-test-"));
try {
    const dir = path.join(root, "fixture");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "global.env"), "IMAGE_PREFIX=example.test/org\nIMAGE_TAG=9.4.1\n");
    fs.writeFileSync(path.join(dir, ".env"), "ARCH_SUFFIX=\n");
    fs.writeFileSync(path.join(dir, "compose.yaml"), `services:
  postgres:
    image: \${POSTGRES_IMAGE:-\${IMAGE_PREFIX}/safeline-postgres\${ARCH_SUFFIX}:15.18}
  mgt:
    image: \${IMAGE_PREFIX}/safeline-mgt:\${IMAGE_TAG:?image
      tag required}
`);
    const stack = new Stack({ stacksDir: root } as DockgeServer, "fixture");
    const images = await stack.getImageList();
    assert.deepEqual(images, [ "example.test/org/safeline-postgres:15.18", "example.test/org/safeline-mgt:9.4.1" ]);
    console.log("COMPOSE_NESTED_DEFAULT_REQUIRED_GLOBAL_ENV_OK");
} finally {
    fs.rmSync(root, { recursive: true });
}
