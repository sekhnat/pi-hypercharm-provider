import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type WarningSink = (message: string) => void;

export interface Notifier {
	/** Emit a deduplicated warning through the currently available output. */
	warn: WarningSink;
	/** Route future warnings through this session's UI (no-op without a UI). */
	activate(ctx: ExtensionContext): void;
}

/**
 * Fetch and parse failures must never be silent, and must never spam: warnings
 * are deduplicated by message for the life of the process. Until a UI session
 * activates the notifier they go to stderr (visible in print/json modes); after
 * activation they go through ctx.ui.notify. A stale ctx — a refresh landing
 * after its session was replaced — falls back to stderr instead of throwing.
 */
export function createNotifier(): Notifier {
	const seenWarnings = new Set<string>();
	const toStderr: WarningSink = (message) => {
		process.stderr.write(`HyperCharm warning: ${message}\n`);
	};
	let emit: WarningSink = toStderr;

	return {
		warn(message) {
			if (seenWarnings.has(message)) return;
			seenWarnings.add(message);
			emit(message);
		},

		activate(ctx) {
			let hasUI = false;
			try {
				hasUI = ctx.hasUI;
			} catch {
				return;
			}
			if (!hasUI) return;
			emit = (message) => {
				try {
					ctx.ui.notify(message, "warning");
				} catch {
					toStderr(message);
				}
			};
		},
	};
}
