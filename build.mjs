import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/app.js",
  minify: true,
  logLevel: "info",
});
cpSync("index.html", "dist/index.html");
console.log("dist/ ready: index.html + app.js");
