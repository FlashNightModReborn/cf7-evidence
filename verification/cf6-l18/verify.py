import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile


PREFIX = 'tools/cf6-elder-assets/e/l18'
OLD = 'tools/cf6-elder-assets/evidence/20261018-loader-size-followup'
HERE = Path(__file__).resolve().parent
BASE = '9f1192f1aa932eeac152f98e00882926e3dc3d65'
SEALED_SWF_SHA = 'ff9290d7918bccda94cf7e0c98517b0f234c5a3236a104d433d1e77f45004b70'


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, encoding='utf-8')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--proof', type=Path, required=True)
    args = parser.parse_args()
    game = args.game.resolve(strict=True)
    require(command('git', '-C', str(game), 'rev-parse', 'HEAD').stdout.strip() == BASE, 'Wrong baseline checkout.')
    require(not (game / PREFIX).exists(), 'The sparse checkout already contains archived payloads.')
    status_command = ('git', '-C', str(game), 'status', '--porcelain=v1', '--untracked-files=all')
    before = command(*status_command).stdout
    require(not before.strip(), f'Frozen sparse checkout was dirty before replay:\n{before}')
    tree = subprocess.check_output(['git', '-C', str(game), 'ls-tree', '-r', '-l', '-z', BASE, '--', PREFIX])
    original = {}
    for item in filter(None, tree.split(b'\0')):
        header, path = item.split(b'\t', 1)
        mode, kind, oid, size = header.decode('ascii').split()
        original[path.decode('utf-8')] = (mode, oid, int(size))
    require(len(original) == 309, 'Unexpected source tree coverage.')

    with tempfile.TemporaryDirectory(prefix='l18-', dir=os.environ['RUNNER_TEMP']) as scratch:
        root = Path(scratch)
        tool = root / 'repo' / 'tools' / 'cf6-elder-assets'
        tool.mkdir(parents=True)
        for name in ('restore_evidence.py', 'evidence-archive-index.json', 'evidence_paths.py', 'evidence-paths.js'):
            shutil.copyfile(HERE / name, tool / name)
        baseline = game / 'tools' / 'cf6-elder-assets'
        for name in ('evidence-path-map.json', 'test_evidence_paths.py', 'analyze-arena.py'):
            shutil.copyfile(baseline / name, tool / name)

        output = root / '证据 回读'
        old_receipt = OLD + '/summary.json'
        picked = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'restore_evidence.py'), old_receipt,
                         '--output', str(output)).stdout.strip()
        require(Path(picked) == output / PREFIX / 'summary.json', 'Historical alias did not resolve to the restored receipt.')
        report = json.loads(Path(picked).read_text(encoding='utf-8-sig'))
        require(report['loaderC6']['sha256'].lower() == SEALED_SWF_SHA, 'Restored summary is not the historical C6 result.')

        recovered = {path.relative_to(output).as_posix(): path for path in output.rglob('*') if path.is_file()}
        require(set(recovered) == set(original), 'Recovered set does not equal the pinned Git tree.')
        for name, path in recovered.items():
            mode, oid, size = original[name]
            data = path.read_bytes()
            actual_blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            require(mode == '100644' and size == len(data) and oid == actual_blob, f'Recovered Git object differs: {name}')
        integrity = json.loads((output / PREFIX / 'integrity.json').read_text('utf-8-sig'))
        for entry in integrity['files']:
            data = recovered[PREFIX + '/' + entry['path']].read_bytes()
            require(len(data) == entry['bytes'] and hashlib.sha256(data).hexdigest() == entry['sha256'], 'Historical integrity row differs.')
        require(integrity['fileCount'] == len(integrity['files']) == 308, 'Historic integrity coverage differs.')

        swf = output / PREFIX / 'records' / 'publish' / 'asLoader.swf'
        require(hashlib.sha256(swf.read_bytes()).hexdigest() == SEALED_SWF_SHA, 'Restored SWF identity differs.')
        sizing = command('node', str(game / 'tools' / 'swf-function-sizes.js'), str(swf), '--max', '60000', '--top', '1').stdout
        require(re.search(r'\b53041 B\b', sizing), 'Current SWF reader did not reproduce the historical largest function.')

        alias_suite = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'test_evidence_paths.py'))
        python_block = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'evidence_paths.py'), 'new', 'l18', 'new.json', check=False)
        require(python_block.returncode != 0 and 'retired' in python_block.stderr, 'Python path helper accepted a new sealed-batch file.')
        node = ('const {validateOutput} = require(process.argv[1]); '
                'try { validateOutput(process.argv[2], process.argv[3]); process.exitCode = 1; } '
                'catch (e) { if (!String(e).includes("retired")) throw e; }')
        command('node', '-e', node, str(tool / 'evidence-paths.js'), str(root / 'repo' / PREFIX / 'new.json'), str(root / 'repo'))

        corrupt = root / 'wrong.zip'
        corrupt.write_bytes(b'invalid archive')
        reject_to = root / 'rejected'
        rejected = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'restore_evidence.py'), PREFIX + '/summary.json',
                           '--archive', str(corrupt), '--output', str(reject_to), check=False)
        require(rejected.returncode != 0 and 'SHA-256' in rejected.stderr and not reject_to.exists(), 'Wrong archive was not safely rejected.')
        after = command(*status_command).stdout
        require(not (game / PREFIX).exists() and before == after, f'The game checkout changed during replay:\n{after}')

        proof = {
            'platform': platform.platform(), 'gameCommit': BASE, 'archivedPrefix': PREFIX, 'legacyLookup': old_receipt,
            'gitBlobsMatched': len(original), 'historicalIntegrityRowsMatched': len(integrity['files']),
            'swfSha256': SEALED_SWF_SHA, 'swfFunctionBytes': 53041, 'wrongArchiveRejected': True,
            'outputOutsideGameCheckout': True, 'retiredPrefixRejectsFutureWrites': True,
            'archiveIndex': json.loads((tool / 'evidence-archive-index.json').read_text('utf-8')),
            'prospectiveFileSha256': {name: hashlib.sha256((tool / name).read_bytes()).hexdigest() for name in (
                'restore_evidence.py', 'evidence-archive-index.json', 'evidence_paths.py', 'evidence-paths.js')},
            'aliasSuite': alias_suite.stderr.strip(),
        }
        args.proof.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(proof, ensure_ascii=False))


if __name__ == '__main__':
    main()
