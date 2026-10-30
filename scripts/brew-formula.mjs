#!/usr/bin/env node
// Prints Formula/peras.rb for the vertias3u/homebrew-tap repo.
//   node scripts/brew-formula.mjs 0.5.0                 the published npm tarball (after npm publish)
//   node scripts/brew-formula.mjs 0.5.0 --tarball x.tgz  a local `npm pack` file, for a test install
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [version, flag, file] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || (flag && flag !== "--tarball") || (flag && !file)) {
  console.error("Usage: node scripts/brew-formula.mjs <version> [--tarball <file.tgz>]");
  process.exit(2);
}

let url, bytes;
if (flag) {
  url = `file://${path.resolve(file)}`;
  bytes = fs.readFileSync(file);
} else {
  url = `https://registry.npmjs.org/peras-cli/-/peras-cli-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) { console.error(`${url}: HTTP ${response.status}. Publish ${version} to npm first.`); process.exit(1); }
  bytes = Buffer.from(await response.arrayBuffer());
}
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

process.stdout.write(`class Peras < Formula
  desc "Pause Claude Code and Codex before they burn your usage window"
  homepage "https://peras.vertias.eu"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Run \`peras setup\` (and \`peras codex setup\` for Codex) now and after each upgrade:
      the hooks run their own copy of Peras.
      The Mac menu bar app is at https://peras.vertias.eu/app
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/peras --version").strip
  end
end
`);
