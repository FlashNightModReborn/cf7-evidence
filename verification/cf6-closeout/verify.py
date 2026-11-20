import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import wave
import zipfile

HERE = Path(__file__).resolve().parent
BASE = 'e4846cb1b69e974ac80f3793c618c06fd4110386'

ARCHIVED_PREFIXES = (
    'tools/cf6-elder-assets/e/l18',
    'tools/cf6-elder-assets/e/c17',
    'tools/cf6-elder-assets/evidence/20261017',
    'tools/cf6-elder-assets/evidence/20261017-playtest',
    'tools/cf6-audio/evidence/20261017-combat-audio',
)

ALL_RETIRED_PREFIXES = (
    'tools/cf6-elder-assets/evidence/20261017-calibration',
    'tools/cf6-elder-assets/evidence/20261018-loader-size-followup',
    *ARCHIVED_PREFIXES,
)

EXPECTED_COUNTS = {
    'tools/cf6-elder-assets/e/l18': 309,
    'tools/cf6-elder-assets/e/c17': 4774,
    'tools/cf6-elder-assets/evidence/20261017': 1987,
    'tools/cf6-elder-assets/evidence/20261017-playtest': 492,
    'tools/cf6-audio/evidence/20261017-combat-audio': 1099,
}

C17_SOURCE_ZIP_SHA = '4f1134e05a00409af4f01acf95f2634559cf41340ee61014f210d60e29afee61'
AUDIO_ORIG_SWF_SHA = 'b52af10e2dda43332e0b2ffb9549d2fad474f298b9f6c67d848ffc33ff589b01'
AUDIO_BEFORE_ZIP_SHA = '845aec5bedc43a64721a7375b4e739dad9ebd202c6165bd26353d54a70f7171b'
AUDIO_CUR_ZIP_SHA = 'fb588a4e9a3239896beea8c417ca82168ee607b12eaf1239ac4879ec2c84a4c7'


def command(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, encoding='utf-8')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_tree_map(game: Path, prefix: str) -> dict:
    raw = subprocess.check_output(['git', '-C', str(game), 'ls-tree', '-r', '-l', '-z', BASE, '--', prefix])
    entries = {}
    for item in filter(None, raw.split(b'\0')):
        header, rel = item.split(b'\t', 1)
        mode, kind, oid, size = header.decode('ascii').split()
        require(kind == 'blob', f'Unexpected git object kind: {kind}')
        entries[rel.decode('utf-8')] = (mode, oid, int(size))
    return entries


def verify_restored_tree(output_dir: Path, prefix: str, original: dict, check_integrity: bool = True) -> dict:
    recovered = {p.relative_to(output_dir).as_posix(): p for p in output_dir.rglob('*') if p.is_file()}
    require(set(recovered) == set(original), f'Recovered file set mismatch for {prefix}')
    for name, path in recovered.items():
        mode, oid, size = original[name]
        data = path.read_bytes()
        actual_blob = hashlib.sha1(f'blob {len(data)}\0'.encode('ascii') + data).hexdigest()
        require(mode == '100644' and size == len(data) and oid == actual_blob, f'Git blob mismatch: {name}')
    integrity_count = 0
    if check_integrity:
        integ_path = output_dir / prefix / 'integrity.json'
        integrity = json.loads(integ_path.read_text('utf-8-sig'))
        for entry in integrity['files']:
            data = recovered[prefix + '/' + entry['path']].read_bytes()
            require(len(data) == entry['bytes'] and sha256_bytes(data) == entry['sha256'],
                    f'integrity.json mismatch: {prefix}/{entry["path"]}')
        require(integrity['fileCount'] == len(integrity['files']), f'integrity fileCount mismatch: {prefix}')
        integrity_count = len(integrity['files'])
    return {'files': len(recovered), 'integrityRows': integrity_count}


def verify_lossless_mapping(batch_dir: Path) -> dict:
    mapping = json.loads((batch_dir / 'lossless-mapping.json').read_text('utf-8-sig'))['files']
    restored_sources = {}
    for row in mapping:
        encoded = b''.join((batch_dir / part['path']).read_bytes() for part in row['parts'])
        for part in row['parts']:
            pdata = (batch_dir / part['path']).read_bytes()
            require(len(pdata) == part['bytes'] and sha256_bytes(pdata) == part['sha256'],
                    f'Lossless part mismatch: {part["path"]}')
        require(row['encoding'] in ('identity', 'gzip'), f'Unexpected encoding: {row["encoding"]}')
        data = gzip.decompress(encoded) if row['encoding'] == 'gzip' else encoded
        require(len(data) == row['originalBytes'] and sha256_bytes(data) == row['originalSha256'],
                f'Lossless restored hash mismatch: {row["source"]}')
        restored_sources[row['source']] = data
    return {'entries': len(mapping), 'sources': restored_sources}


def wav_max_sample_diff(bytes_a: bytes, bytes_b: bytes) -> int:
    with wave.open(io.BytesIO(bytes_a), 'rb') as wa, wave.open(io.BytesIO(bytes_b), 'rb') as wb:
        require(wa.getparams()[:4] == wb.getparams()[:4], 'WAV params mismatch')
        fa, fb = wa.readframes(wa.getnframes()), wb.readframes(wb.getnframes())
    require(len(fa) == len(fb) and len(fa) % 2 == 0, 'WAV frame length mismatch')
    import struct
    sa = struct.unpack(f'<{len(fa)//2}h', fa)
    sb = struct.unpack(f'<{len(fb)//2}h', fb)
    return max(abs(x - y) for x, y in zip(sa, sb)) if sa else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--proof', type=Path, required=True)
    args = parser.parse_args()
    game = args.game.resolve(strict=True)
    require(command('git', '-C', str(game), 'rev-parse', 'HEAD').stdout.strip() == BASE, 'Wrong baseline checkout.')
    for prefix in ARCHIVED_PREFIXES:
        require(not (game / prefix).exists(), f'Sparse checkout unexpectedly contains {prefix}')
    status_command = ('git', '-C', str(game), 'status', '--porcelain=v1', '--untracked-files=all')
    before = command(*status_command).stdout
    require(not before.strip(), f'Frozen sparse checkout was dirty before replay:\n{before}')

    originals = {}
    for prefix, count in EXPECTED_COUNTS.items():
        tree_map = git_tree_map(game, prefix)
        require(len(tree_map) == count, f'Unexpected tree count for {prefix}: {len(tree_map)} != {count}')
        originals[prefix] = tree_map

    base_temp = os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix='c6-', dir=base_temp) as scratch:
        root = Path(scratch)
        tool = root / 'repo' / 'tools' / 'cf6-elder-assets'
        tool.mkdir(parents=True)
        for name in ('restore_evidence.py', 'evidence-archive-index.json', 'evidence_paths.py', 'evidence-paths.js'):
            shutil.copyfile(HERE / name, tool / name)
        baseline = game / 'tools' / 'cf6-elder-assets'
        for name in ('evidence-path-map.json', 'test_evidence_paths.py', 'analyze-arena.py'):
            shutil.copyfile(baseline / name, tool / name)

        def run_restore(req_path: str, short_name: str) -> tuple[Path, Path]:
            out = root / short_name
            picked = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'restore_evidence.py'),
                             req_path, '--output', str(out)).stdout.strip()
            return out, Path(picked)

        # 1. Restore e/l18 & e/c17, verify cross-batch linkage & run active analyze-arena.py
        l18_out, l18_picked = run_restore('tools/cf6-elder-assets/evidence/20261018-loader-size-followup/summary.json', 'l18')
        require(l18_picked == l18_out / 'tools/cf6-elder-assets/e/l18/summary.json', 'l18 alias resolution failed')
        l18_stats = verify_restored_tree(l18_out, 'tools/cf6-elder-assets/e/l18', originals['tools/cf6-elder-assets/e/l18'])
        l18_summary = json.loads(l18_picked.read_text('utf-8-sig'))

        c17_out, c17_picked = run_restore('tools/cf6-elder-assets/evidence/20261017-calibration/summary.json', 'c17')
        require(c17_picked == c17_out / 'tools/cf6-elder-assets/e/c17/summary.json', 'c17 alias resolution failed')
        c17_stats = verify_restored_tree(c17_out, 'tools/cf6-elder-assets/e/c17', originals['tools/cf6-elder-assets/e/c17'])
        c17_dir = c17_out / 'tools/cf6-elder-assets/e/c17'
        c17_integrity_sha = sha256_bytes((c17_dir / 'integrity.json').read_bytes())
        require(c17_integrity_sha == l18_summary['priorC5Calibration']['filesUnchanged']['integritySha256'],
                'C6->C5 cross-batch integrity SHA-256 mismatch')

        c17_src_gz = b''.join((c17_dir / f'current-final-source.zip.gz.part{i:03d}').read_bytes() for i in range(1, 4))
        c17_src_zip = gzip.decompress(c17_src_gz)
        require(sha256_bytes(c17_src_zip) == C17_SOURCE_ZIP_SHA, 'c17 source zip SHA mismatch')
        c17_src = root / 'c17src'
        for rel in (
            'scripts/引擎/引擎_lsy_等级与经验值.as',
            'scripts/逻辑/单位函数/单位函数_fs_aka_玩家模板迁移.as',
            'scripts/类定义/org/flashNight/arki/component/Damage/CrumbleDamageHandle.as',
            'flashswf/arts/things5/LIBRARY/敌人-方舟兽王.xml',
            'flashswf/arts/things5/LIBRARY/Symbol 2151.xml',
        ):
            dst = c17_src / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            src_file = game / rel
            if src_file.is_file():
                shutil.copyfile(src_file, dst)
            else:
                dst.write_bytes(subprocess.check_output(['git', '-C', str(game), 'show', f'{BASE}:{rel}']))
        with zipfile.ZipFile(io.BytesIO(c17_src_zip)) as zf:
            zf.extractall(c17_src)
        c17_out_json = root / 'c17-r22.json'
        command(sys.executable, '-X', 'utf8', '-B', str(tool / 'analyze-arena.py'),
                '--results', str(c17_dir / 'history/r22-full-awake/all-results.json'),
                '--source-root', str(c17_src),
                '--expected-levels', '60', '80', '100',
                '--output', str(c17_out_json))
        c17_analysis = json.loads(c17_out_json.read_text('utf-8'))
        require(c17_analysis['fullMatrix'] is True and len(c17_analysis['rows']) == 36 and len(c17_analysis['groups']) == 6,
                'analyze-arena.py R22 verification failed')

        # 2. Restore evidence/20261017, verify integrity, lossless mapping & recompute R15 matrix
        d17_out, d17_picked = run_restore('tools/cf6-elder-assets/evidence/20261017/summary.json', 'd17')
        require(d17_picked == d17_out / 'tools/cf6-elder-assets/evidence/20261017/summary.json', 'd17 path mismatch')
        d17_stats = verify_restored_tree(d17_out, 'tools/cf6-elder-assets/evidence/20261017', originals['tools/cf6-elder-assets/evidence/20261017'])
        d17_dir = d17_out / 'tools/cf6-elder-assets/evidence/20261017'
        d17_lossless = verify_lossless_mapping(d17_dir)
        d17_src_index = json.loads((d17_dir / 'frozen-inputs.zip.index.json').read_text('utf-8-sig'))['files']
        with zipfile.ZipFile(io.BytesIO(d17_lossless['sources']['current verified source inputs'])) as zf:
            require(zf.testzip() is None and zf.namelist() == [r['path'] for r in d17_src_index], 'd17 frozen-inputs zip index mismatch')
            for r in d17_src_index:
                zdata = zf.read(r['path'])
                require(len(zdata) == r['bytes'] and sha256_bytes(zdata) == r['sha256'], f'd17 frozen-inputs entry mismatch: {r["path"]}')
        d17_summary = json.loads(d17_picked.read_text('utf-8-sig'))
        unique_rows = {}
        for jp in (d17_dir / 'matrix').rglob('*.jsonl'):
            for line in jp.read_text('utf-8-sig').splitlines():
                if not line:
                    continue
                item = json.loads(line)
                if 'authorityContext' in item and 'candidateSide' in item['authorityContext']:
                    k = (item['batchId'], item['runId'])
                    if k in unique_rows:
                        require(unique_rows[k] == item, 'Duplicate row conflict in d17 matrix')
                    unique_rows[k] = item
        require(len(unique_rows) == 36, f'd17 matrix row count != 36: {len(unique_rows)}')
        d17_rows = list(unique_rows.values())
        for grp in d17_summary['levels']:
            sub = [r for r in d17_rows if r['authorityContext']['rivalUnitId'] == grp['rivalUnitId'] and r['authorityContext']['level'] == grp['level']]
            require(len(sub) == 6, 'd17 group size != 6')
            vals = []
            for r in sub:
                other = 'red' if r['authorityContext']['candidateSide'] == 'blue' else 'blue'
                vals.append(100 * (1 - r[other]['remainHp'] / r[other]['startMaxHp']))
            for metric, val in (('minPercent', min(vals)), ('maxPercent', max(vals)),
                                ('meanPercent', statistics.mean(vals)), ('medianPercent', statistics.median(vals))):
                require(abs(grp[metric] - val) < 1e-9, f'd17 group metric mismatch: {metric}')

        # 3. Restore evidence/20261017-playtest, verify integrity, lossless mapping & closeout binding
        p17_out, p17_picked = run_restore('tools/cf6-elder-assets/evidence/20261017-playtest/summary.json', 'p17')
        require(p17_picked == p17_out / 'tools/cf6-elder-assets/evidence/20261017-playtest/summary.json', 'p17 path mismatch')
        p17_stats = verify_restored_tree(p17_out, 'tools/cf6-elder-assets/evidence/20261017-playtest', originals['tools/cf6-elder-assets/evidence/20261017-playtest'])
        p17_dir = p17_out / 'tools/cf6-elder-assets/evidence/20261017-playtest'
        p17_lossless = verify_lossless_mapping(p17_dir)
        p17_closeout = json.loads((game / 'tools/cf6-elder-assets/evidence/20261017-playtest-closeout/summary.json').read_text('utf-8-sig'))
        p17_integ_sha = sha256_bytes((p17_dir / 'integrity.json').read_bytes())
        require(p17_integ_sha == p17_closeout['primaryIntegritySha256'], 'Playtest closeout integrity SHA mismatch')
        p17_src_idx = json.loads((p17_dir / 'current-source-and-assets.zip.index.json').read_text('utf-8-sig'))['files']
        with zipfile.ZipFile(p17_dir / 'current-source-and-assets.zip') as zf:
            require(zf.testzip() is None and zf.namelist() == [r['path'] for r in p17_src_idx], 'p17 source zip index mismatch')

        # 4. Restore 20261017-combat-audio, verify integrity, lossless mapping & run active audit.py + extract.py
        a17_out, a17_picked = run_restore('tools/cf6-audio/evidence/20261017-combat-audio/summary.json', 'a17')
        require(a17_picked == a17_out / 'tools/cf6-audio/evidence/20261017-combat-audio/summary.json', 'a17 path mismatch')
        a17_stats = verify_restored_tree(a17_out, 'tools/cf6-audio/evidence/20261017-combat-audio', originals['tools/cf6-audio/evidence/20261017-combat-audio'])
        a17_dir = a17_out / 'tools/cf6-audio/evidence/20261017-combat-audio'
        a17_lossless = verify_lossless_mapping(a17_dir)
        a17_integ_sha = sha256_bytes((a17_dir / 'integrity.json').read_bytes())
        closeout_integ_sha = sha256_bytes((game / 'tools/cf6-audio/evidence/20261017-combat-audio-closeout/primary-package-integrity.json').read_bytes())
        require(a17_integ_sha == closeout_integ_sha, 'Audio closeout primary-package-integrity SHA mismatch')

        orig_swf_gz = b''.join((a17_dir / f'original-cf6/source.swf.gz.part{i:03d}').read_bytes() for i in range(1, 3))
        orig_swf = gzip.decompress(orig_swf_gz)
        require(sha256_bytes(orig_swf) == AUDIO_ORIG_SWF_SHA, 'Restored original CF6 SWF SHA mismatch')
        orig_swf_path = root / 'orig-cf6.swf'
        orig_swf_path.write_bytes(orig_swf)

        before_zip_path = a17_dir / 'attempts/before-source.zip'
        require(sha256_bytes(before_zip_path.read_bytes()) == AUDIO_BEFORE_ZIP_SHA, 'before-source.zip SHA mismatch')

        ca_src_gz = b''.join((a17_dir / f'current-source.zip.gz.part{i:03d}').read_bytes() for i in range(1, 9))
        ca_src_zip = gzip.decompress(ca_src_gz)
        require(sha256_bytes(ca_src_zip) == AUDIO_CUR_ZIP_SHA, 'combat-audio current-source.zip SHA mismatch')
        arepo = root / 'arepo'
        with zipfile.ZipFile(io.BytesIO(ca_src_zip)) as zf:
            zf.extractall(arepo)
        for rel in ('tools/cf6-audio/extract.py', 'tools/cf6-audio/audit.py', 'tools/cf6-audio/source.py', 'tools/swf-audit/swfscan.py'):
            dst = arepo / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(game / rel, dst)

        # 4a. Run active audit.py on exact frozen SHA-256 inputs first
        audit_out = root / 'audio-audit'
        command(sys.executable, '-X', 'utf8', '-B', str(arepo / 'tools/cf6-audio/audit.py'),
                '--source-swf', str(orig_swf_path),
                '--baseline-zip', str(before_zip_path),
                '--output', str(audit_out))
        audit_res = json.loads((audit_out / 'audit.json').read_text('utf-8'))
        require(audit_res['newLibraryCount'] == 8 and audit_res['newUnitOrFormCount'] == 12, 'audit library/unit count mismatch')
        require(audit_res['originalTimelineSitesMissingBefore'] == 45 and audit_res['originalTimelineSitesMissingAfter'] == 0,
                'audit missing site count mismatch')
        require(len(audit_res['decodedAssets']) == 44 and audit_res['restoredLegacyWav']['decodeToEnd'] is True,
                'audit decoded assets check failed')

        # 4b. Run active extract.py --write and compare all 41 unmodified MP3s byte-for-byte & 3 envelope WAVs sample-accurate
        assets_before = json.loads((arepo / 'tools/cf6-audio/assets.json').read_text('utf-8'))
        before_wav_bytes = {
            row['name']: (arepo / row['path']).read_bytes()
            for row in assets_before['files'] if row.get('envelope')
        }
        command(sys.executable, '-X', 'utf8', '-B', str(arepo / 'tools/cf6-audio/extract.py'),
                '--source-swf', str(orig_swf_path), '--write')
        assets_after = json.loads((arepo / 'tools/cf6-audio/assets.json').read_text('utf-8'))
        for key in ('schema', 'sourceSwfSha256', 'sourceFps', 'cuesSha256', 'embeddedSoundTracks'):
            require(assets_after[key] == assets_before[key], f'extract.py changed {key}')
        require(len(assets_after['files']) == len(assets_before['files']) == 44, 'extract.py file count mismatch')
        wav_exact = True
        wav_max_diff = 0
        for r_old, r_new in zip(assets_before['files'], assets_after['files']):
            for fkey in ('name', 'path', 'soundId', 'derivation', 'envelope'):
                require(r_old[fkey] == r_new[fkey], f'extract.py metadata mismatch: {fkey}')
            if r_old['envelope'] is None:
                require(r_old['bytes'] == r_new['bytes'] and r_old['sha256'] == r_new['sha256'],
                        f'extract.py MP3 payload mismatch: {r_old["name"]}')
            else:
                if r_old['sha256'] != r_new['sha256']:
                    wav_exact = False
                    diff = wav_max_sample_diff(before_wav_bytes[r_old['name']], (arepo / r_new['path']).read_bytes())
                    wav_max_diff = max(wav_max_diff, diff)
                    require(diff <= 2, f'Envelope WAV sample drift > 2 LSB ({diff}) on {r_old["name"]}')

        # 5. Path guards, unit tests, corrupt archive & in-checkout output rejection
        alias_suite = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'test_evidence_paths.py'))
        for retired in ALL_RETIRED_PREFIXES:
            py_blk = command(sys.executable, '-X', 'utf8', '-B', '-c',
                             'import sys; sys.path.insert(0, sys.argv[1]); from evidence_paths import validate_output; '
                             'from pathlib import Path; validate_output(Path(sys.argv[2]), Path(sys.argv[3]))',
                             str(tool), str(root / 'repo' / retired / 'new.json'), str(root / 'repo'), check=False)
            require(py_blk.returncode != 0 and 'retired' in py_blk.stderr, f'Python accepted retired prefix: {retired}')
            js_blk = command('node', '-e',
                             'const {validateOutput} = require(process.argv[1]); '
                             'try { validateOutput(process.argv[2], process.argv[3]); process.exitCode = 1; } '
                             'catch (e) { if (!String(e).includes("retired")) throw e; }',
                             str(tool / 'evidence-paths.js'), str(root / 'repo' / retired / 'new.json'), str(root / 'repo'))

        corrupt = root / 'wrong.zip'
        corrupt.write_bytes(b'invalid archive')
        reject_to = root / 'rejected'
        rejected = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'restore_evidence.py'),
                           'tools/cf6-elder-assets/e/c17/summary.json',
                           '--archive', str(corrupt), '--output', str(reject_to), check=False)
        require(rejected.returncode != 0 and 'SHA-256' in rejected.stderr and not reject_to.exists(),
                'Corrupt ZIP was not safely rejected')

        in_checkout = command(sys.executable, '-X', 'utf8', '-B', str(tool / 'restore_evidence.py'),
                              'tools/cf6-elder-assets/e/c17/summary.json',
                              '--archive', str(corrupt), '--output', str(root / 'repo' / 'out'), check=False)
        require(in_checkout.returncode != 0 and 'outside the game checkout' in in_checkout.stderr,
                'In-checkout output path was not rejected')

        # 6. Confirm frozen game checkout stayed clean
        after = command(*status_command).stdout
        require(all(not (game / p).exists() for p in ARCHIVED_PREFIXES) and before == after,
                f'Frozen game checkout changed during replay:\n{after}')

        proof = {
            'schema': 1,
            'platform': platform.platform(),
            'gameCommit': BASE,
            'restoredBatches': {
                'e/l18': l18_stats,
                'e/c17': c17_stats,
                'evidence/20261017': d17_stats,
                'evidence/20261017-playtest': p17_stats,
                '20261017-combat-audio': a17_stats,
            },
            'consumers': {
                'c17AnalyzeArena': {
                    'fullMatrix': c17_analysis['fullMatrix'],
                    'rows': len(c17_analysis['rows']),
                    'groups': len(c17_analysis['groups']),
                    'crossBatchIntegrityMatch': True,
                },
                'd17MatrixAndLossless': {
                    'losslessEntries': d17_lossless['entries'],
                    'frozenInputFiles': len(d17_src_index),
                    'matrixRowsRecomputed': len(d17_rows),
                },
                'p17PlaytestAndCloseout': {
                    'losslessEntries': p17_lossless['entries'],
                    'closeoutIntegrityMatch': True,
                    'sourceZipFiles': len(p17_src_idx),
                },
                'combatAudioExtractAndAudit': {
                    'losslessEntries': a17_lossless['entries'],
                    'closeoutIntegrityMatch': True,
                    'auditNewLibraries': audit_res['newLibraryCount'],
                    'auditMissingAfter': audit_res['originalTimelineSitesMissingAfter'],
                    'auditDecodedAssets': len(audit_res['decodedAssets']),
                    'extractFiles': len(assets_after['files']),
                    'extractMp3Exact': True,
                    'extractWavExact': wav_exact,
                    'extractWavMaxSampleDiff': wav_max_diff,
                    'ffmpegVersion': assets_after['ffmpegVersion'],
                },
            },
            'guards': {
                'aliasSuite': alias_suite.stderr.strip(),
                'retiredPrefixesBlocked': len(ALL_RETIRED_PREFIXES),
                'corruptArchiveRejected': True,
                'inCheckoutOutputRejected': True,
                'frozenCheckoutClean': True,
            },
            'archiveIndex': json.loads((tool / 'evidence-archive-index.json').read_text('utf-8')),
        }
        args.proof.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'ok': True, 'platform': proof['platform'], 'consumers': proof['consumers']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
