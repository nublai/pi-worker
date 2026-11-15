"""Task-owned isolated-copy regression/reversion runner. Never edits checkout."""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRATCH = pathlib.Path(os.environ["A0_S7_SCRATCH"]).resolve(strict=True)
OUT = SCRATCH / "reversions"
OUT.mkdir(parents=True, exist_ok=True)
TESTS = ["gate1-git", "gate1-sibling", "gate1-native-binding", "gate1-parent"]


def copy(name, base=False):
    dst = pathlib.Path(tempfile.mkdtemp(prefix=name + "-", dir=OUT))
    if base:
        archive = subprocess.check_output(["git", "archive", "b461253"], cwd=ROOT)
        subprocess.run(["tar", "-x", "-C", str(dst)], input=archive, check=True)
        for f in TESTS:
            shutil.copyfile(
                ROOT / "src/test" / f"{f}.test.ts", dst / "src/test" / f"{f}.test.ts"
            )
        # B461253 has no per-parent router parameter. The new broker-specific
        # portable case is tested red on pre-fix 249be1b separately; keep the
        # literal kernel parent fixture in this older-base comparison.
        parent_test = dst / "src/test/gate1-parent.test.ts"
        text = parent_test.read_text()
        start = text.index("test('parent channel staging")
        end = text.index("// Literal Gate 1 test 11:")
        parent_test.write_text(text[:start] + text[end:])
    else:
        for f in [
            "src",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "openapi.json",
        ]:
            if (ROOT / f).is_dir():
                shutil.copytree(ROOT / f, dst / f)
            else:
                shutil.copyfile(ROOT / f, dst / f)
    (dst / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    return dst


def run(dst, tests, name, expected):
    env = {**os.environ, "A0_TEST_BWRAP": "1", "TMPDIR": str(SCRATCH)}
    build = subprocess.run(
        ["npm", "run", "build"],
        cwd=dst,
        env=env,
        capture_output=True,
        timeout=60,
        check=False,
    )
    (OUT / f"{name}-build.log").write_bytes(build.stdout + build.stderr)
    if build.returncode:
        raise RuntimeError(name + " did not compile")
    t = time.time()
    p = subprocess.run(
        ["node", "--test", *[f"dist/test/{f}.test.js" for f in tests]],
        cwd=dst,
        env=env,
        capture_output=True,
        timeout=90,
        check=False,
    )
    log = p.stdout + p.stderr
    (OUT / f"{name}.log").write_bytes(log)
    killed = p.returncode != 0 and (b"ERR_ASSERTION" in log or b"AssertionError" in log)
    row = {
        "name": name,
        "build_exit": build.returncode,
        "test_exit": p.returncode,
        "assertion_failure": killed,
        "duration_seconds": round(time.time() - t, 3),
        "tests": tests,
        "expected": expected,
        "pass": killed if expected == "red" else p.returncode == 0,
    }
    if not row["pass"]:
        raise RuntimeError(json.dumps(row))
    return row


rows = []
dst = copy("base", True)
rows.append(run(dst, TESTS, "base-b461253", "red"))
dst = copy("fixed")
rows.append(run(dst, TESTS + ["gate1-artifact"], "fixed", "green"))
mutants = [
    (
        "profile-link-dereference",
        "src/server.ts",
        "dereference: false, verbatimSymlinks: true",
        "dereference: true",
        ["gate1-parent"],
    ),
    (
        "git-mounts",
        "src/sandbox.ts",
        "...gitWorktreeMounts(root)",
        "...[]",
        ["gate1-git"],
    ),
    (
        "git-namespace",
        "src/git-sandbox.ts",
        "if (readdirSync(refs).some(name => name !== leaf))",
        "if (false)",
        ["gate1-git"],
    ),
    (
        "parent-unconfined",
        "src/host.ts",
        "if (context?.launch_spec?.environment.filesystem === 'bwrap')",
        "if (context?.parent && context?.launch_spec?.environment.filesystem === 'bwrap')",
        ["gate1-parent"],
    ),
    (
        "channel-other-worker",
        "src/server.ts",
        "const owned = (id: string) => !channel || id === channel.workerId || supervisor.require(id).worker.parent_worker_id === channel.workerId;",
        "const owned = (_id: string) => true;",
        ["gate1-parent"],
    ),
    (
        "native-binding",
        "src/supervisor.ts",
        "if (event.type === 'host_binding') this.nativeBinding(live, event);",
        "if (event.type === 'host_binding') { /* reverted */ }",
        ["gate1-native-binding"],
    ),
    (
        "sdk-native-tree",
        "src/sdk-child.ts",
        "pi.on('session_tree', (_event, ctx) => {",
        "pi.on('session_tree', (_event, ctx) => { return;",
        ["gate1-native-binding"],
    ),
    (
        "rpc-native-tree",
        "src/rpc-audit.ts",
        "pi.on('session_tree', (_event, ctx) => binding(ctx, 'tree'));",
        "pi.on('session_tree', () => {});",
        ["gate1-native-binding"],
    ),
    (
        "sibling",
        "src/supervisor.ts",
        "if (!live.host?.answerUI && (event.type === 'tool_execution_end' || event.type === 'agent_settled'))",
        "if (event.type === 'tool_execution_end' || event.type === 'agent_settled')",
        ["gate1-sibling"],
    ),
    (
        "evidence-tree",
        "src/artifact.ts",
        "const tree_id = git('rev-parse', '--verify', commit_id + '^{tree}');",
        "const tree_id = commit_id;",
        ["gate1-artifact"],
    ),
    (
        "evidence-advisory",
        "src/artifact.ts",
        "advisory: true, git_version",
        "advisory: false, git_version",
        ["gate1-artifact"],
    ),
    (
        "evidence-git-version",
        "src/artifact.ts",
        "const git_version = git('--version');",
        "const git_version = 'unrecorded';",
        ["gate1-artifact"],
    ),
]
for name, path, old, new, tests in mutants:
    dst = copy(name)
    p = dst / path
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError((name, text.count(old)))
    p.write_text(text.replace(old, new))
    rows.append(run(dst, tests, name, "red"))
(OUT / "results.json").write_text(
    json.dumps(
        {
            "base": "b461253",
            "method": "isolated copies; compile then assertion-only rejection; no timeouts accepted",
            "results": rows,
        },
        indent=2,
    )
    + "\n"
)
print(json.dumps(rows, indent=2))
