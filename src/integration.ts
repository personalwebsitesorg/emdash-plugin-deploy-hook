/**
 * Astro Integration — Auto-prerender public pages
 *
 * 1. Uses astro:route:setup to set prerender=true on public routes
 * 2. Uses a Vite transform to inject getStaticPaths() into dynamic routes
 *    by detecting which EmDash collection/taxonomy they use
 */

import type { AstroIntegration } from "astro";

interface DeployHookOptions {
	/**
	 * Route patterns to keep as SSR (not prerendered).
	 * Defaults to ["/search"]. Admin routes (/_emdash) are always excluded.
	 */
	dynamic?: string[];
}

export function deployHook(options: DeployHookOptions = {}): AstroIntegration {
	const dynamicRoutes = new Set(options.dynamic ?? ["/search"]);

	return {
		name: "emdash-deploy-hook",
		hooks: {
			"astro:route:setup": ({ route }) => {
				// Only prerender user pages in src/pages/
				if (!route.component.startsWith("src/pages/")) return;

				// Skip routes the user marked as dynamic
				for (const pattern of dynamicRoutes) {
					if (route.component.includes(pattern.replace(/^\//, ""))) return;
				}

				// Force prerender for all public pages
				route.prerender = true;
			},

			"astro:config:setup": ({ updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [staticPathsVitePlugin()],
					},
				});
			},
		},
	};
}

/**
 * Vite plugin that auto-injects getStaticPaths() into dynamic .astro pages.
 *
 * By the time this transform runs, the Astro compiler has already converted
 * .astro files into JavaScript. So we prepend the getStaticPaths export
 * to the compiled JS module.
 */
function staticPathsVitePlugin() {
	return {
		name: "emdash-deploy-hook:static-paths",

		transform(code: string, id: string) {
			// Only process compiled .astro files with dynamic params
			if (!id.endsWith(".astro") || !id.includes("[")) return null;

			// Skip if already has getStaticPaths
			if (code.includes("getStaticPaths")) return null;

			// Skip admin routes
			if (id.includes("_emdash")) return null;

			// Detect collection usage: getEmDashEntry("posts" or getEmDashCollection("posts"
			const collectionMatch = code.match(
				/(?:getEmDashEntry|getEmDashCollection)\s*\(\s*["']([^"']+)["']/,
			);

			// Detect taxonomy usage: getTerm("tag" or getTerms("tag"
			const taxonomyMatch = code.match(
				/(?:getTerm|getTerms)\s*\(\s*["']([^"']+)["']/,
			);

			if (!collectionMatch && !taxonomyMatch) return null;

			let injection: string;

			if (taxonomyMatch) {
				injection = buildTaxonomyStaticPaths(taxonomyMatch[1]);
			} else if (collectionMatch) {
				injection = buildCollectionStaticPaths(collectionMatch[1]);
			} else {
				return null;
			}

			// Prepend the getStaticPaths export to the compiled JavaScript
			return { code: injection + "\n" + code, map: null };
		},
	};
}

function buildCollectionStaticPaths(collection: string): string {
	return `
import { getEmDashCollection as __getCollection } from "emdash";
export async function getStaticPaths() {
	const { entries } = await __getCollection("${collection}");
	return entries.map((e) => ({ params: { slug: e.id } }));
}
`;
}

function buildTaxonomyStaticPaths(taxonomy: string): string {
	return `
import { getTaxonomyTerms as __getTaxonomyTerms } from "emdash";
export async function getStaticPaths() {
	const terms = await __getTaxonomyTerms("${taxonomy}");
	return terms.map((t) => ({ params: { slug: t.slug } }));
}
`;
}
