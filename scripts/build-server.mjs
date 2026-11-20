import { build } from "esbuild";
import { existsSync } from "node:fs";

const outfile = "dist/server.js";

await build({
  entryPoints: ["server.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "external",
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

if (!existsSync(outfile)) {
  console.error("build failed: dist/server.js not produced");
  process.exit(1);
}
console.log("built", outfile);
