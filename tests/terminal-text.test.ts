import { test } from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "@xterm/xterm";
import { terminalText } from "../frontend/src/utils/terminal-text";

test("wrapped rows become logical lines while true newlines remain", () => {
    const lines = [
        { value: "long line ",
            isWrapped: false },
        { value: "continues",
            isWrapped: true },
        { value: "next line  ",
            isWrapped: false },
        { value: "",
            isWrapped: false },
    ];
    const terminal = {
        buffer: { active: { length: lines.length,
            getLine: (i: number) => lines[i] && {
                isWrapped: lines[i].isWrapped,
                translateToString: (trim: boolean) => trim ? lines[i].value.trimEnd() : lines[i].value,
            } } },
    } as unknown as Terminal;
    assert.equal(terminalText(terminal), "long line continues\nnext line");
});
