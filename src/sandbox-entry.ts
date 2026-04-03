/**
 * Sandbox Entry — Deploy Hook Plugin
 *
 * Admin UI with "Build & Deploy" button.
 * Calls a configurable deploy hook URL to trigger a site rebuild.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

// ── Helpers ──

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function getSettings(ctx: PluginContext) {
	const hookUrl = (await ctx.kv.get<string>("settings:hookUrl")) ?? "";
	const lastBuild = (await ctx.kv.get<string>("state:lastBuild")) ?? "";
	const lastStatus = (await ctx.kv.get<string>("state:lastStatus")) ?? "";
	return { hookUrl, lastBuild, lastStatus };
}

async function triggerBuild(
	ctx: PluginContext,
	hookUrl: string,
): Promise<{ success: boolean; error?: string }> {
	if (!hookUrl) return { success: false, error: "No deploy hook URL configured" };
	if (!ctx.http) return { success: false, error: "Network access not available" };

	try {
		const res = await ctx.http.fetch(hookUrl, { method: "POST" });
		const success = res.ok;

		await ctx.kv.set("state:lastBuild", new Date().toISOString());
		await ctx.kv.set("state:lastStatus", success ? "triggered" : `failed (${res.status})`);

		if (!success) {
			return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
		}
		return { success: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await ctx.kv.set("state:lastBuild", new Date().toISOString());
		await ctx.kv.set("state:lastStatus", `error: ${msg}`);
		return { success: false, error: msg };
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
					"Enter your deploy hook URL below. You get this from Cloudflare Workers Builds (or Vercel/Netlify) after connecting your GitHub repo.",
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

	// Status fields
	const fields: { label: string; value: string }[] = [
		{ label: "Hook URL", value: hookUrl.length > 50 ? hookUrl.slice(0, 50) + "..." : hookUrl },
		{ label: "Status", value: lastStatus || "Never built" },
	];
	if (lastBuild) {
		fields.push({ label: "Last Build", value: new Date(lastBuild).toLocaleString() });
	}
	blocks.push({ type: "fields", fields });

	// Build button
	blocks.push({
		type: "actions",
		elements: [
			{
				type: "button",
				text: "Build & Deploy",
				action_id: "trigger_build",
				style: "primary",
				confirm: {
					title: "Build & Deploy?",
					text: "This will rebuild your site with the latest content from the database. It may take a minute.",
					confirm: "Build",
					deny: "Cancel",
				},
			},
		],
	});

	// Settings form at bottom
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
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};

				// Page load
				if (interaction.type === "page_load") {
					return { blocks: await buildAdminPage(ctx) };
				}

				// Save settings
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					if (typeof values.hookUrl === "string" && values.hookUrl) {
						await ctx.kv.set("settings:hookUrl", values.hookUrl);
					}
					return {
						blocks: await buildAdminPage(ctx),
						toast: { message: "Settings saved", type: "success" },
					};
				}

				// Trigger build
				if (interaction.type === "block_action" && interaction.action_id === "trigger_build") {
					const hookUrl = (await ctx.kv.get<string>("settings:hookUrl")) ?? "";
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

		// API route for status checks
		status: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const { hookUrl, lastBuild, lastStatus } = await getSettings(ctx);
				return {
					configured: !!hookUrl,
					lastBuild,
					lastStatus,
				};
			},
		},

		// API route to trigger build programmatically
		build: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const hookUrl = (await ctx.kv.get<string>("settings:hookUrl")) ?? "";
				return await triggerBuild(ctx, hookUrl);
			},
		},
	},
});
