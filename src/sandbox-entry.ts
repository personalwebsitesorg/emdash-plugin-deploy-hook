/**
 * Sandbox Entry — Deploy Hook Plugin
 *
 * Admin UI with "Build & Deploy" button.
 * Calls a configurable deploy hook URL to trigger a site rebuild.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { validateUrl, FETCH_TIMEOUT_MS, BUILD_DEBOUNCE_MS } from "./validation.js";

// types

interface Interaction {
	type: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

interface Settings {
	hookUrl: string;
	lastBuild: string;
	lastStatus: string;
}

// ── Helpers ──

function isInteraction(value: unknown): value is Interaction {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.type === "string";
}

async function getSettings(ctx: PluginContext): Promise<Settings> {
	const hookUrl = (await ctx.kv.get<string>("settings:hookUrl")) ?? "";
	const lastBuild = (await ctx.kv.get<string>("state:lastBuild")) ?? "";
	const lastStatus = (await ctx.kv.get<string>("state:lastStatus")) ?? "";
	return { hookUrl, lastBuild, lastStatus };
}

async function updateBuildState(
	ctx: PluginContext,
	status: string,
): Promise<void> {
	await ctx.kv.set("state:lastBuild", new Date().toISOString());
	await ctx.kv.set("state:lastStatus", status);
}

async function triggerBuild(
	ctx: PluginContext,
	hookUrl: string,
): Promise<{ success: boolean; error?: string }> {
	if (!hookUrl) return { success: false, error: "No deploy hook URL configured" };
	if (!ctx.http) return { success: false, error: "Network access not available" };

	// Debounce: reject if last build was less than 60s ago
	const lastBuild = await ctx.kv.get<string>("state:lastBuild");
	if (lastBuild) {
		const elapsed = Date.now() - new Date(lastBuild).getTime();
		if (elapsed < BUILD_DEBOUNCE_MS) {
			const wait = Math.ceil((BUILD_DEBOUNCE_MS - elapsed) / 1000);
			return { success: false, error: `Please wait ${wait}s before triggering another build` };
		}
	}

	const validation = validateUrl(hookUrl);
	if (!validation.valid) {
		return { success: false, error: validation.error };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		const res = await ctx.http.fetch(hookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timestamp: new Date().toISOString() }),
			signal: controller.signal,
		});

		clearTimeout(timeout);

		const success = res.ok;
		await updateBuildState(ctx, success ? "triggered" : `failed (${res.status})`);

		if (!success) {
			ctx.log?.error?.(`Deploy hook failed: HTTP ${res.status} ${res.statusText}`);
			return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
		}
		ctx.log?.info?.("Deploy hook triggered successfully");
		return { success: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const isTimeout = err instanceof Error && err.name === "AbortError";
		const status = isTimeout ? "error: request timed out" : `error: ${msg}`;
		await updateBuildState(ctx, status);
		ctx.log?.error?.(`Deploy hook error: ${msg}`);
		return { success: false, error: isTimeout ? "Request timed out" : msg };
	}
}

// ── Block Kit Pages ──

async function buildAdminPage(ctx: PluginContext) {
	const { hookUrl, lastBuild, lastStatus } = await getSettings(ctx);

	const blocks: unknown[] = [{ type: "header", text: "Deploy" }];

	if (!hookUrl) {
		blocks.push(
			{
				type: "banner",
				title: "Setup required",
				description:
					"Enter your deploy hook URL below. You get this from Cloudflare Workers Builds after connecting your GitHub repo.",
				variant: "default",
			},
			{
				type: "form",
				block_id: "setup",
				fields: [
					{
						type: "text_input",
						action_id: "hookUrl",
						label: "Deploy Hook URL",
						placeholder: "https://api.cloudflare.com/client/v4/accounts/.../workers/builds/hooks/...",
					},
				],
				submit: { label: "Save", action_id: "save_settings" },
			},
		);
		return blocks;
	}

	// Status
	const fields: { label: string; value: string }[] = [
		{ label: "Hook URL", value: hookUrl.length > 50 ? hookUrl.slice(0, 50) + "..." : hookUrl },
		{ label: "Status", value: lastStatus || "Never built" },
	];
	if (lastBuild) {
		fields.push({ label: "Last Build", value: new Date(lastBuild).toLocaleString() });
	}
	blocks.push({ type: "fields", fields });

	// Build button
	blocks.push(
		{ type: "context", text: "Rebuild your site with the latest content from the database." },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					label: "Build & Deploy",
					action_id: "trigger_build",
					style: "primary",
				},
			],
		},
	);

	// Settings
	blocks.push(
		{ type: "divider" },
		{ type: "header", text: "Settings" },
		{
			type: "form",
			block_id: "settings",
			fields: [
				{
					type: "text_input",
					action_id: "hookUrl",
					label: "Deploy Hook URL",
					initial_value: hookUrl,
				},
			],
			submit: { label: "Update", action_id: "save_settings" },
		},
		{ type: "divider" },
		{ type: "header", text: "D1 Build Token" },
		{
			type: "context",
			text: "For fast builds, create a Cloudflare API token with D1 read permission. Then add it as a build environment variable named CF_D1_TOKEN in your Cloudflare Workers Builds settings (Settings → Builds → Build variables).",
		},
		{
			type: "banner",
			title: "How to create the token",
			description: "Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom Token → Permissions: D1 (Read) → Create. Then copy the token and add it as CF_D1_TOKEN in your Workers Builds settings.",
			variant: "default",
		},
	);

	return blocks;
}

// ── Plugin Definition ──

export default definePlugin({
	routes: {
		admin: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				if (!isInteraction(routeCtx.input)) {
					ctx.log?.error?.("Invalid interaction payload received");
					return { blocks: await buildAdminPage(ctx) };
				}

				const interaction = routeCtx.input;

				if (interaction.type === "page_load") {
					return { blocks: await buildAdminPage(ctx) };
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					const hookUrl = typeof values.hookUrl === "string" ? values.hookUrl.trim() : "";

					if (!hookUrl) {
						return {
							blocks: await buildAdminPage(ctx),
							toast: { message: "URL is required", type: "error" },
						};
					}

					const validation = validateUrl(hookUrl);
					if (!validation.valid) {
						ctx.log?.error?.(`Invalid deploy hook URL rejected: ${validation.error}`);
						return {
							blocks: await buildAdminPage(ctx),
							toast: { message: validation.error ?? "Invalid URL", type: "error" },
						};
					}

					await ctx.kv.set("settings:hookUrl", hookUrl);
					ctx.log?.info?.("Deploy hook URL saved");
					return {
						blocks: await buildAdminPage(ctx),
						toast: { message: "Settings saved", type: "success" },
					};
				}

				if (interaction.type === "block_action" && interaction.action_id === "trigger_build") {
					const { hookUrl } = await getSettings(ctx);
					const result = await triggerBuild(ctx, hookUrl);
					return {
						blocks: await buildAdminPage(ctx),
						toast: {
							message: result.success
								? "Build triggered! Your site will update in about a minute."
								: `Build failed: ${result.error}`,
							type: result.success ? "success" : "error",
						},
					};
				}

				return { blocks: await buildAdminPage(ctx) };
			},
		},

		status: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const { hookUrl, lastBuild, lastStatus } = await getSettings(ctx);
				return { configured: !!hookUrl, lastBuild, lastStatus };
			},
		},

		build: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const { hookUrl } = await getSettings(ctx);
				return await triggerBuild(ctx, hookUrl);
			},
		},
	},
});
