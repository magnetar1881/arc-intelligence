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

await build({
  entryPoints: ["src/peach-client.js"],
  bundle: true,
  outfile: "public/peach-bundle.js",
  format: "iife",
  globalName: "PeachSwapBundle",
  platform: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
    "global": "window",
  },
  minify: true,
});

console.log("✅ peach-bundle.js oluşturuldu");
