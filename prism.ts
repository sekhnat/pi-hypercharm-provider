import { PRISM_ENTRY_TYPE } from "./identity";

export { PRISM_ENTRY_TYPE };

/** Longest routing label we accept (mirrors the official provider's limit). */
const MAX_LABEL_LENGTH = 200;
/** Control, format, line-separator, and paragraph-separator characters. */
const UNSAFE_LABEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface PrismRoute {
	modelName?: string;
	modelId?: string;
}

/** Trimmed, length- and character-checked routing label; undefined when unusable. */
export function prismLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const label = value.trim();
	if (label === "" || label.length > MAX_LABEL_LENGTH || UNSAFE_LABEL.test(label)) return undefined;
	return label;
}

/** Route captured from a provider response; undefined when neither header is usable. */
export function prismRouteFromHeaders(headers: Record<string, string> | undefined): PrismRoute | undefined {
	if (!headers) return undefined;
	const modelName = prismLabel(headers["x-prism-model-name"]);
	const modelId = prismLabel(headers["x-prism-model-id"]);
	return modelName !== undefined || modelId !== undefined ? { modelName, modelId } : undefined;
}

/** Re-validate persisted entry data: session files are user-editable input. */
export function readPrismRoute(data: unknown): PrismRoute | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	const modelName = prismLabel(record.modelName);
	const modelId = prismLabel(record.modelId);
	return modelName !== undefined || modelId !== undefined ? { modelName, modelId } : undefined;
}

/** What to show for a route: the human name when present, else the model id. */
export function prismRouteLabel(route: PrismRoute): string | undefined {
	return route.modelName ?? route.modelId;
}
