// shared validation and sanitization utilities

export const FETCH_TIMEOUT_MS = 30_000;
export const ALLOWED_URL_PROTOCOLS = ["https:"] as const;
export const MAX_URL_LENGTH = 2048;
export const BUILD_DEBOUNCE_MS = 60_000;

// validates a deploy hook URL.
// must be https, well-formed and within length limits
export function validateUrl(url: string): { valid: boolean; error?: string } {
	if (!url || typeof url !== "string") {
		return { valid: false, error: "URL is required" };
	}
	if (url.length > MAX_URL_LENGTH) {
		return { valid: false, error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` };
	}
	try {
		const parsed = new URL(url);
		if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol as typeof ALLOWED_URL_PROTOCOLS[number])) {
			return { valid: false, error: "Only HTTPS URLs are allowed" };
		}
		return { valid: true };
	} catch {
		return { valid: false, error: "Invalid URL format" };
	}
}

// sanitizes a name (collection/taxonomy) to only allow safe characters
export function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "");
}
