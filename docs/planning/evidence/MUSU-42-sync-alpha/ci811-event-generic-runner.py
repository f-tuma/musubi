import hashlib, json, os, signal, subprocess, time
from pathlib import Path

root = Path('/home/flamendrin/workspace/musubi')
prefix = Path('/tmp/musu42-ci811-event-generic-v1')
def inputs():
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    files += ['apps/api/src/sync/owned_database_fixture_cleanup.ts']
    return {name: hashlib.sha256(b'symlink:' + os.readlink(root / name).encode() if (root / name).is_symlink()
                                else b'file:' + (root / name).read_bytes()).hexdigest()
            for name in sorted(set(files)) if name}
before = inputs()
prefix.with_suffix('.inputs.json').write_text(json.dumps(before, indent=2) + '\n')
env = dict(os.environ, ENVIRONMENT='test', DATABASE_URL='postgres://postgres:musubi_c10_ci811_fixture@127.0.0.1:55448/postgres',
           MUSUBI_EVENT_COMPATIBILITY_SUITE='generic-native', MUSUBI_EVENT_COMPATIBILITY_OUTPUT=str(prefix) + '-output')
start = time.time()
with prefix.with_suffix('.log').open('wb') as log:
    child = subprocess.Popen(['pnpm', '--filter', '@musubi/api', 'exec', 'tsx', 'src/sync/event_compatibility_delivery.integration.test.ts'],
                             cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = child.wait(timeout=300)
    except BaseException:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        raise
after = inputs()
changed = [name for name in before.keys() | after.keys() if before.get(name) != after.get(name)]
log = prefix.with_suffix('.log').read_bytes()
receipt = {'schemaVersion': 1, 'kind': 'actual-generic-native-fixture-after-ci811-cleanup-fix', 'exitCode': code,
           'elapsedSeconds': round(time.time() - start, 3), 'inputFiles': len(before), 'trackedOrHelperChanges': changed,
           'inputsSha256': hashlib.sha256(prefix.with_suffix('.inputs.json').read_bytes()).hexdigest(),
           'logSha256': hashlib.sha256(log).hexdigest(), 'output': str(prefix) + '-output',
           'wholeCurrentHeadCiRequired': True, 'productionDeployed': False}
prefix.with_suffix('.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
raise SystemExit(code if code else bool(changed))
