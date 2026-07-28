import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = dirname(fileURLToPath(import.meta.url));
const seed = join(sandbox, ".seed", "work");
const target = join(sandbox, "work");
const resolvedSandbox = realpathSync(sandbox);
const resolvedTargetParent = realpathSync(dirname(target));

if (!existsSync(seed) || resolvedTargetParent !== resolvedSandbox || resolve(target) !== join(resolvedSandbox, "work")) {
  throw new Error("Refusing to reset outside test/protocol-sandbox/work");
}

rmSync(target, { recursive: true, force: true });
cpSync(seed, target, { recursive: true, preserveTimestamps: false });
console.log(`Reset disposable protocol sandbox: ${target}`);
