import type { Terminal } from "@xterm/xterm";

/** Read rendered logical lines, not raw ANSI output or visual wrapped rows. */
export function terminalText(terminal: Terminal): string {
    const buffer = terminal.buffer.active;
    let text = "";
    for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (!line) {
            continue;
        }
        if (index > 0 && !line.isWrapped) {
            text += "\n";
        }
        const nextWrapped = buffer.getLine(index + 1)?.isWrapped === true;
        text += line.translateToString(!nextWrapped);
    }
    return text.replace(/\n+$/, "");
}

/** Clipboard API requires HTTPS; legacy copy supports LAN HTTP pages. */
export async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch { /* Retry through user-initiated legacy copy. */ }
    }
    const focused = document.activeElement as HTMLElement | null;
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    try {
        area.select();
        if (!document.execCommand("copy")) {
            throw new Error("Clipboard copy failed");
        }
    } finally {
        area.remove();
        focused?.focus();
    }
}
