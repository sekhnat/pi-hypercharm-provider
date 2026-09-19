/**
 * Bounded TypeBox validation diagnostics for Hyper endpoint payloads.
 *
 * Pure module — no pi imports, no network. Consumers (oauth.ts, provider.ts,
 * account.ts) describe each endpoint as a TypeBox schema and run every
 * response through validateEndpoint() before the payload may touch models,
 * credentials, or status state (specs/hyper-api-reliability).
 *
 * Schemas are forward-compatible on purpose: required documented fields and
 * ranges are enforced, unknown additive properties are allowed. Exact
 * additionalProperties:false schemas were rejected — a harmless additive Hyper
 * field must not take an otherwise healthy account or login path offline.
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Maximum validation diagnostics reported per failed payload. */
export const DEFAULT_MAX_VALIDATION_ERRORS = 5;

export type EndpointValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Format one TypeBox instance path ("/models/0/cost/input") as a stable,
 * endpoint-safe locator ("models[0].cost.input"). Segment text is structural —
 * property keys and array indices only, never instance values — and
 * non-identifier keys are JSON-quoted so unusual server-side field names
 * cannot smuggle arbitrary text into diagnostics.
 */
export function formatErrorPath(path: string): string {
	const trimmed = path.replace(/^\//, "");
	if (trimmed.length === 0) return "(root)";
	const parts: string[] = [];
	for (const segment of trimmed.split("/")) {
		if (/^\d+$/.test(segment)) {
			// Array index: attach to the previous part as a subscript.
			if (parts.length > 0) parts[parts.length - 1] += `[${segment}]`;
			else parts.push(`[${segment}]`);
			continue;
		}
		if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
			parts.push(parts.length === 0 ? segment : `.${segment}`);
		} else {
			parts.push(parts.length === 0 ? JSON.stringify(segment) : `${JSON.stringify(segment)}`);
		}
	}
	return parts.join("");
}

/**
 * Validate an endpoint payload against its schema. Reports at most
 * maxErrors formatted diagnostics (as "path: message" lines) so a wildly
 * malformed payload cannot flood the warning sink; truncation is stated
 * explicitly.
 */
export function validateEndpoint<T extends TSchema>(
	schema: T,
	value: unknown,
	maxErrors: number = DEFAULT_MAX_VALIDATION_ERRORS,
): EndpointValidation<Static<T>> {
	if (Value.Check(schema, value)) return { ok: true, value: value as Static<T> };
	const all = [...Value.Errors(schema, value)];
	const limit = Math.max(1, maxErrors);
	const bounded = all.slice(0, limit).map((error) => {
		const path = formatErrorPath(typeof error.instancePath === "string" ? error.instancePath : "");
		return `${path}: ${typeof error.message === "string" ? error.message : "is invalid"}`;
	});
	if (all.length > bounded.length) {
		// The validator itself produced strictly more diagnostics than the
		// bound; the total is not knowable (TypeBox caps its own walk), so the
		// notice states omission without a count.
		bounded.push("(further validation diagnostics omitted)");
	}
	return { ok: false, errors: bounded };
}

// ─── Shared endpoint-schema building blocks ───────────────────────────────────

/** A required non-empty trimmed string (device codes, tokens, names). */
export const NonEmptyString = Type.String({ minLength: 1 });

/** A finite number (accepts any range; consumers add bounds via Type.Number modifiers). */
export const FiniteNumber = Type.Number();

/** TypeBox helpers used to express "finite and in range" numeric limits. */
export function positiveInt(options?: Record<string, unknown>) {
	return Type.Integer({ minimum: 1, ...options });
}

/** Type.Object wrapper documenting that unknown properties stay allowed. */
export function EndpointObject(properties: Record<string, TSchema>, description?: string) {
	// additionalProperties is intentionally NOT false: additive Hyper fields
	// are forward-compatible (see module docstring).
	return Type.Object(properties, description ? { description } : undefined);
}
