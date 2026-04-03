/**
 * EmDash Deploy Hook Plugin — Descriptor
 *
 * Turns any EmDash site into a static site with one-click deploys.
 * Install, add to config, click "Build & Deploy" in admin.
 */

import type { PluginDescriptor } from "emdash";

export { deployHook } from "./integration.js";

export function deployHookPlugin(): PluginDescriptor {
	return {
		id: "deploy-hook",
		version: "1.0.0",
		format: "standard",
		entrypoint: "emdash-plugin-deploy-hook/sandbox",
		capabilities: ["network:fetch:any"],
		adminPages: [{ path: "/deploy", label: "Deploy", icon: "rocket" }],
	};
}
