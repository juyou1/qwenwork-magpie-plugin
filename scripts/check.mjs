import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const files = [join(root, "index.mjs")]
for (const directory of ["src", "test"]) {
  for (const name of readdirSync(join(root, directory))) {
    if (name.endsWith(".mjs")) files.push(join(root, directory, name))
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`Syntax OK: ${files.length} files`)
