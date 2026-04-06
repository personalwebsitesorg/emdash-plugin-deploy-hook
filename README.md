# emdash-plugin-deploy-hook

Static site generation plugin for [EmDash CMS](https://emdashcms.com). Converts public pages to pre-built HTML files served instantly with zero database queries. The admin panel continues working normally.

## Features

- One-click **Build & Deploy** from the admin panel
- Auto-prerenders all public pages as static HTML at build time
- No page file modifications needed — works automatically
- Admin panel (`/_emdash/*`) stays server-rendered with full D1 access
- Works with Cloudflare Workers Builds, or any CI/CD with deploy hooks
- Configurable — choose which routes stay dynamic

## Install

```bash
npm install github:mohamedmostafa58/emdash-plugin-deploy-hook
```

## Setup

### 1. Add to `astro.config.mjs`

```typescript
import { deployHook, deployHookPlugin } from "emdash-plugin-deploy-hook";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: {
    resolve: {
      dedupe: ["emdash"],
      preserveSymlinks: true,
    },
  },
  integrations: [
    react(),
    emdash({
      plugins: [formsPlugin(), deployHookPlugin()],
      // ...rest of your config
    }),
    deployHook(),  // must come AFTER emdash()
  ],
});
```

### 2. Add the build script

Create `build.sh` in your project root. This script copies your production D1 data into the local build environment so Astro can prerender pages with real content.

See the full `build.sh` in the [documentation](DEPLOY-HOOK-PLUGIN.md). Replace `YOUR_DB_NAME` with your D1 database name from `wrangler.jsonc`.

Update `package.json`:

```json
{
  "scripts": {
    "build": "bash build.sh",
    "build:ssr": "astro build"
  }
}
```

### 3. Connect GitHub to Cloudflare

1. Cloudflare Dashboard → Workers & Pages → your worker → Settings → Builds
2. Connect to Git → select your repo
3. Build command: `npm run build`
4. Deploy command: `npx wrangler deploy`

### 4. Configure the plugin

1. Create a Deploy Hook in Cloudflare Builds settings
2. Go to your admin panel → Plugins → Deploy
3. Paste the hook URL → Save
4. Click **Build & Deploy**

## Options

```typescript
deployHook({
  dynamic: ["/search"],  // routes to keep as SSR (default: ["/search"])
})
```

Admin routes are always excluded automatically.

## API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_emdash/api/plugins/deploy-hook/status` | POST | Returns build status and configuration |
| `/_emdash/api/plugins/deploy-hook/build` | POST | Triggers a build programmatically |

## Requirements

- EmDash >= 0.0.3
- Astro >= 5.0.0
- Cloudflare Workers with D1
- GitHub repo connected to Cloudflare Workers Builds

## License

MIT
