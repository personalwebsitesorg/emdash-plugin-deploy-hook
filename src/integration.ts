/**
 * Astro Integration — Static site generation for EmDash
 *
 * Everything is automatic:
 * 1. astro:build:start — syncs production D1 to local SQLite (reads wrangler config)
 * 2. astro:route:setup — sets prerender=true on public pages
 * 3. astro:config:setup — Vite plugin injects getStaticPaths() into [slug] pages
 *
 * Auth: reads CF_D1_TOKEN env var for fast API mode. Falls back to wrangler CLI.
 */

import type { AstroIntegration, AstroIntegrationLogger } from "astro";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeName } from "./validation.js";

interface DeployHookOptions {
	/** Routes to keep as SSR. Defaults to ["/search"]. Admin routes always excluded. */
	dynamic?: string[];
}

// Tables needed for rendering public pages
const RENDER_TABLES = new Set([
	"_emdash_collections", "_emdash_fields", "_emdash_taxonomy_defs",
	"_emdash_menus", "_emdash_menu_items",
	"_emdash_widgets", "_emdash_widget_areas",
	"_emdash_bylines", "_emdash_content_bylines",
	"_emdash_sections", "_emdash_comments", "_emdash_seo",
	"_emdash_settings", "_emdash_migrations", "_emdash_migrations_lock",
	"taxonomies", "content_taxonomies", "media", "revisions", "users",
]);

// Only allow safe characters in identifiers
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isRenderTable(name: string): boolean {
	return name.startsWith("ec_") || RENDER_TABLES.has(name);
}

function isSafeIdentifier(name: string): boolean {
	return SAFE_IDENTIFIER.test(name) && name.length <= 128;
}

export function deployHook(options: DeployHookOptions = {}): AstroIntegration {
	const dynamicRoutes = new Set(options.dynamic ?? ["/search"]);

	return {
		name: "emdash-deploy-hook",
		hooks: {
			"astro:build:start": async ({ logger }) => {
				await syncD1(logger);
			},

			"astro:route:setup": ({ route }) => {
				if (!route.component.startsWith("src/pages/")) return;
				for (const pattern of dynamicRoutes) {
					if (route.component.includes(pattern.replace(/^\//, ""))) return;
				}
				route.prerender = true;
			},

			"astro:config:setup": ({ updateConfig }) => {
				updateConfig({ vite: { plugins: [staticPathsVitePlugin()] } });
			},
		},
	};
}

// ── Wrangler Config Reader ──

interface WranglerD1Config {
	accountId: string;
	dbId: string;
	dbName: string;
}

function readWranglerConfig(logger: AstroIntegrationLogger): WranglerD1Config | null {
	const candidates = ["wrangler.jsonc", "wrangler.json"];
	let raw: string | null = null;

	for (const file of candidates) {
		if (existsSync(file)) {
			raw = readFileSync(file, "utf8");
			break;
		}
	}

	if (!raw) {
		logger.warn("No wrangler.jsonc or wrangler.json found — skipping D1 sync");
		return null;
	}

	try {
		const clean = raw
			.replace(/\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/,\s*([}\]])/g, "$1");
		const cfg = JSON.parse(clean);
		const accountId = cfg.account_id;
		const db = cfg.d1_databases?.[0];

		if (!accountId || !db?.database_id || !db?.database_name) {
			logger.warn("Missing account_id or D1 database config in wrangler config");
			return null;
		}

		if (!isSafeIdentifier(db.database_name)) {
			logger.error(`Unsafe database name: ${db.database_name}`);
			return null;
		}

		return { accountId, dbId: db.database_id, dbName: db.database_name };
	} catch (err) {
		logger.warn(`Failed to parse wrangler config: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

// ── D1 Sync ──

async function syncD1(logger: AstroIntegrationLogger) {
	const config = readWranglerConfig(logger);
	if (!config) return;

	const { accountId, dbId, dbName } = config;
	const token = process.env.CF_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
	const useApi = !!token;
	const tmpDir = mkdtempSync(join(tmpdir(), "emdash-d1-"));

	logger.info(useApi ? "Syncing D1 via API" : "Syncing D1 via wrangler CLI (set CF_D1_TOKEN for faster builds)");
	const t0 = Date.now();

	// ── Query helpers ──

	async function apiQuery(sql: string): Promise<any[]> {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ sql }),
			},
		);
		const json = await res.json() as any;
		if (!json.success) {
			throw new Error(json.errors?.[0]?.message || `D1 API error (HTTP ${res.status})`);
		}
		return json.result?.[0]?.results || [];
	}

	function cliQuery(sql: string): any[] {
		const sqlFile = join(tmpDir, "query.sql");
		writeFileSync(sqlFile, sql);
		try {
			const out = execFileSync("npx", [
				"wrangler", "d1", "execute", dbName,
				"--remote", "--json", "--file", sqlFile,
			], { maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
			return JSON.parse(out.toString())[0]?.results || [];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`wrangler query failed: ${msg}`);
			return [];
		}
	}

	function localExec(filePath: string): void {
		execFileSync("npx", [
			"wrangler", "d1", "execute", dbName,
			"--local", "--file", filePath,
		], { stdio: "pipe" });
	}

	const query = useApi ? apiQuery : async (sql: string) => cliQuery(sql);

	// ── 1. Get schemas ──

	let allTables: any[];
	try {
		allTables = await query(
			"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		);
	} catch (err) {
		logger.error(`Failed to fetch table list: ${err instanceof Error ? err.message : err}`);
		logger.error("D1 sync failed — site will deploy without prerendered content");
		return;
	}

	const tables = allTables.filter((t: any) => t.sql && isRenderTable(t.name) && isSafeIdentifier(t.name));
	logger.info(`${tables.length} tables (${allTables.length - tables.length} skipped)`);

	if (tables.length === 0) {
		logger.warn("No render tables found — content pages will be empty");
		return;
	}

	// ── 2. Create schemas locally ──

	const schema = tables
		.map((t: any) => t.sql.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS") + ";")
		.join("\n");
	const schemaFile = join(tmpDir, "schema.sql");
	writeFileSync(schemaFile, schema);

	try {
		localExec(schemaFile);
	} catch (err) {
		logger.error(`Failed to create local schemas: ${err instanceof Error ? err.message : err}`);
		return;
	}

	// ── 3. Fetch data ──

	let results: Array<{ name: string; rows: any[] }>;

	try {
		if (useApi) {
			results = await Promise.all(
				tables.map(async (t: any) => ({
					name: t.name,
					rows: await apiQuery(`SELECT * FROM "${t.name}"`),
				})),
			);
		} else {
			results = [];
			for (const t of tables) {
				const rows = cliQuery(`SELECT * FROM "${t.name}"`);
				results.push({ name: t.name, rows });
			}
		}
	} catch (err) {
		logger.error(`Failed to fetch data: ${err instanceof Error ? err.message : err}`);
		logger.error("D1 sync failed — site will deploy without prerendered content");
		return;
	}

	// ── 4. Build + execute one INSERT file ──

	let allSQL = "";
	let total = 0;

	for (const { name, rows } of results) {
		if (!rows.length) continue;
		const cols = Object.keys(rows[0]);
		const colList = cols.map((c) => `"${c}"`).join(",");

		for (const r of rows) {
			const vals = cols.map((c) => {
				const v = r[c];
				if (v == null) return "NULL";
				if (typeof v === "number") return String(v);
				return "'" + String(v).replace(/'/g, "''") + "'";
			}).join(",");
			allSQL += `INSERT OR REPLACE INTO "${name}" (${colList}) VALUES (${vals});\n`;
		}
		total += rows.length;
		logger.info(`  ${name}: ${rows.length} rows`);
	}

	if (allSQL) {
		const dataFile = join(tmpDir, "data.sql");
		writeFileSync(dataFile, allSQL);
		try {
			localExec(dataFile);
		} catch (err) {
			logger.error(`Failed to insert data locally: ${err instanceof Error ? err.message : err}`);
			logger.error("D1 sync failed — site will deploy without prerendered content");
			return;
		}
	}

	logger.info(`Synced ${total} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── Vite Plugin ──

function staticPathsVitePlugin() {
	return {
		name: "emdash-deploy-hook:static-paths",
		transform(code: string, id: string) {
			if (!id.endsWith(".astro") || !id.includes("[")) return null;
			if (code.includes("getStaticPaths") || id.includes("_emdash")) return null;

			const collectionMatch = code.match(/(?:getEmDashEntry|getEmDashCollection)\s*\(\s*["']([a-zA-Z0-9_-]+)["']/);
			const taxonomyMatch = code.match(/(?:getTerm|getTerms)\s*\(\s*["']([a-zA-Z0-9_-]+)["']/);
			if (!collectionMatch && !taxonomyMatch) return null;

			const injection = taxonomyMatch
				? `\nimport { getTaxonomyTerms as __getTaxonomyTerms } from "emdash";\nexport async function getStaticPaths() {\n\tconst terms = await __getTaxonomyTerms(${JSON.stringify(sanitizeName(taxonomyMatch[1]))});\n\treturn terms.map((t) => ({ params: { slug: t.slug } }));\n}\n`
				: `\nimport { getEmDashCollection as __getCollection } from "emdash";\nexport async function getStaticPaths() {\n\tconst { entries } = await __getCollection(${JSON.stringify(sanitizeName(collectionMatch![1]))});\n\treturn entries.map((e) => ({ params: { slug: e.id } }));\n}\n`;

			return { code: injection + code, map: null };
		},
	};
}
