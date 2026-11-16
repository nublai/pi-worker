#!/usr/bin/env node
// Privacy scan for evidence before it is committed (AGENTS.md rule 9): fails if any file under the given paths
// carries something that looks like a credential, a private key, a bearer token or a credential-bearing URL. It
// prints the file, line and pattern name only, never the matched text.
//   node harness/lib/privacy-scan.mjs <file-or-dir>...  → JSON {scanned, findings:[{file,line,pattern}]}, exit 1 on any
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['tailscale_key', /\btskey-[A-Za-z0-9-]{10,}/],
  ['openai_style_key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack_token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer_value', /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{16,}/i],
  ['password_assignment', /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\b["']?\s*[:=]\s*["']?[^\s"']{8,}/i],
  ['url_credential', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['url_token_param', /[?&](?:token|access_token|auth|key|sig|signature|X-Amz-Signature)=[^&\s]{8,}/i],
  ['onepassword_ref', /\bop:\/\/[^\s]+/],
];

function* files(path) {
  const st = statSync(path);
  if (st.isDirectory()) for (const entry of readdirSync(path).sort()) yield* files(join(path, entry));
  else if (st.isFile()) yield path;
}

export function scan(paths) {
  const findings = [];
  let scanned = 0;
  for (const root of paths) {
    for (const file of files(root)) {
      scanned++;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [name, pattern] of PATTERNS) if (pattern.test(line)) findings.push({ file, line: i + 1, pattern: name });
      });
    }
  }
  return { scanned, findings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error('usage: privacy-scan.mjs <file-or-dir>...');
    process.exit(2);
  }
  const result = scan(paths);
  console.log(JSON.stringify(result));
  process.exit(result.findings.length ? 1 : 0);
}
