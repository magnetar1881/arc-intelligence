import { build } from "esbuild";

await build({
  entryPoints: ["src/swap-client.js"],
  bundle: true,
  outfile: "public/swap-bundle.js",
  format: "iife",
  globalName: "SwapKit",
  platform: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
    "global": "window",
  },
  minify: false,
});

console.log("✅ swap-bundle.js oluşturuldu");
