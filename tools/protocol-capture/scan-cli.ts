#!/usr/bin/env node
import { resolve } from "node:path";
import { scanFixtureDirectory } from "./secret-scan.js";

const directory = resolve(process.argv[2] || "test/protocol-fixtures");
const findings = await scanFixtureDirectory(directory);
if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Protocol fixture secret scan passed: ${directory}`);
}
