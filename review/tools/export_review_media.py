"""Export a reviewed offline kit as immutable, on-demand media for one Pages revision."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from math import ceil
from itertools import combinations
from pathlib import Path

from PIL import Image


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_bytes(data, *, readable=False) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2 if readable else None,
                       separators=None if readable else (",", ":")) + "\n").encode("utf-8")


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def assert_same(observed, expected, context):
    if observed != expected:
        raise ValueError(f"{context}: {observed!r} != {expected!r}")


def read_geometry(kit: Path):
    source = kit / "制作记录" / "制作工具" / "overview.py"
    spec = importlib.util.spec_from_file_location("verified_offline_layout", source)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load the reviewed layout: {source}")
    geometry = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = geometry
    spec.loader.exec_module(geometry)
    return geometry


def video_info(file: Path):
    output = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=width,height,codec_name,avg_frame_rate,nb_read_frames,duration",
        "-of", "json", str(file),
    ])
    stream, = json.loads(output)["streams"]
    return (int(stream["width"]), int(stream["height"]), stream["codec_name"],
            Fraction(stream["avg_frame_rate"]), int(stream["nb_read_frames"]),
            round(float(stream["duration"]) * 1000))


def decoded_hash(file: Path, frames: int) -> str:
    output = subprocess.check_output([
        "ffmpeg", "-v", "error", "-threads", "2", "-i", str(file), "-map", "0:v:0",
        "-frames:v", str(frames), "-c:v", "rawvideo", "-threads", "2",
        "-f", "streamhash", "-hash", "SHA256", "-",
    ], text=True).strip()
    if not re.fullmatch(r"0,v,SHA256=[0-9a-f]{64}", output):
        raise ValueError(f"Missing decoded frame digest for {file.name}")
    return output.split("=", 1)[1]


def webp(source: Path, target: Path, *, still=False):
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    if still:
        image.thumbnail((860, 1150), Image.Resampling.LANCZOS)
    image.save(target, "WEBP", quality=84, method=5)
    with Image.open(target) as check:
        check.load()
        assert_same((check.format, check.size), ("WEBP", image.size), target.name)


def valid_slots(slots, ids, width, height):
    assert_same(set(slots), set(ids), "moves covered by click targets")
    for name, (x, y, w, h) in slots.items():
        if not (w > 0 and h > 0 and 0 <= x < x+w <= width and 0 <= y < y+h <= height):
            raise ValueError(f"Click target outside the board: {name}")
    for (a,(ax,ay,aw,ah)),(b,(bx,by,bw,bh)) in combinations(slots.items(),2):
        if ax < bx+bw and bx < ax+aw and ay < by+bh and by < ay+ah:
            raise ValueError(f"Overlapping actions {a} and {b}")


def overview(source, out, name, layout, geometry, rows, expected, include_context):
    stem = "全招对照-" + layout.name
    original_poster, original_video = source/(stem+".png"), source/(stem+".mp4")
    assert_same(sha(original_poster), expected["posterSha256"], original_poster.name)
    assert_same(sha(original_video), expected["videoSha256"], original_video.name)
    poster, movie = "media/overview-"+name+".webp", "media/overview-"+name+".mp4"
    webp(original_poster, out/poster)
    with Image.open(out/poster) as im:
        assert_same(im.size, (layout.width, layout.height), poster)
    cycle = expected["cycleFrames"]
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(original_video), "-map", "0:v:0",
        "-frames:v", str(cycle), "-c", "copy", "-movflags", "+faststart", str(out/movie)
    ], check=True)
    source_meta, exported = video_info(original_video), video_info(out/movie)
    header = (layout.width, layout.height, "h264", Fraction(geometry.FPS))
    assert_same(source_meta[:5], (*header,expected["frames"]), original_video.name)
    assert_same(exported[:5], (*header,cycle), movie)
    if abs(exported[5] - round(cycle * 1000 / geometry.FPS)) > 1:
        raise ValueError(f"Wrong loop duration: {movie}")
    frames_sha = decoded_hash(out/movie, cycle)
    assert_same(frames_sha, decoded_hash(original_video, cycle), "decoded first cycle "+name)
    slots = geometry.collect_rects(layout, rows, include_context)
    ids = [r["id"] for r in rows] + (["C01"] if include_context else [])
    valid_slots(slots, ids, layout.width, layout.height)
    desc = dict(width=layout.width, height=layout.height, poster=poster, movie=movie,
                slots=slots, durationMs=exported[5])
    proof = dict(sourceFrames=source_meta[4], frames=exported[4], fps=str(exported[3]),
                 durationMs=exported[5], decodedFramesSha256=frames_sha)
    return name, desc, proof


def movement_version(identifier, review_hash, sides, provisional, choices):
    # Identical evidence keeps its status across rounds; a changed visual or
    # choice meaning requires a new review. Page revision is deliberately absent.
    basis = {"id":identifier,"comparison":review_hash,"sides":sides,
             "provisional":provisional,"choices":choices}
    return hashlib.sha256(json_bytes(basis)).hexdigest()


def move_record(row, source, out, rates):
    key = row["id"]
    if not re.fullmatch("[US][0-9]{2}", key):
        raise ValueError(f"Unexpected action ID {key}")
    sides = row["sides"]
    if sides not in (1,2):
        raise ValueError(f"Invalid comparison width for {key}")
    provisional = row["relation"] == "待认稿"
    if provisional and sides != 2:
        raise ValueError(key)
    choices = (["use","other","unclear"] if provisional else
               ["match","mismatch","unclear"] if sides==2 else ["yes","no","unclear"])
    original_video = source/row["reviewVideo"]
    review_hash = sha(source/row["reviewGif"])
    assert_same(review_hash, row["reviewSha256"], key+" reviewed comparison")
    video, still = "media/"+key.lower()+".mp4", "media/"+key.lower()+"-still.webp"
    shutil.copyfile(original_video,out/video)
    assert_same(sha(out/video), sha(original_video), key+" MP4 copy")
    width,height,codec,rate,count,ms = video_info(out/video)
    fps,source_fps,game_fps = rates
    assert_same((width,height,codec,rate),(460*sides,434,"h264",fps),key+" media")
    expected_length = max(row["sourceFrames"]/source_fps, row["gameFrames"]/game_fps)
    assert_same(count, ceil(expected_length*fps), key+" delivered frames")
    webp(source/"三格慢看"/(key+" "+row["name"]+".png"),out/still,still=True)
    return dict(id=key,name=row["name"],sides=sides,provisional=provisional,
                version=movement_version(key,review_hash,sides,provisional,choices),
                durationMs=ms,video=video,still=still,choices=choices)


def context_record(kit, source, out):
    receipt = load(kit/"制作记录/烟雾装填接滑铲.json")
    stem = source/"连起来看/C01 烟雾装填接滑铲"
    file = stem.with_suffix(".mp4")
    target = "media/c01.mp4"
    shutil.copyfile(file, out/target)
    assert_same(sha(out/target), sha(file), "C01 MP4 copy")
    _,_,codec,rate,count,ms = video_info(out/target)
    assert_same((codec,rate,count),("h264",Fraction(receipt["captureRate"]),receipt["deliveredFrames"]),"C01")
    choices = ["match","mismatch","unclear"]
    return dict(id="C01",name="烟雾装填接滑铲",sides=1,provisional=False,
                version=movement_version("C01",sha(stem.with_suffix(".gif")),1,False,choices),
                durationMs=ms,video=target,still=None,choices=choices)


def verify_urls(out, manifest):
    urls = set()
    for layout in manifest["layouts"].values():
        urls.update((layout["poster"],layout["movie"]))
    for move in manifest["moves"]:
        urls.add(move["video"])
        if move["still"]:
            urls.add(move["still"])
    actual = {p.relative_to(out).as_posix() for p in (out/"media").iterdir() if p.is_file()}
    assert_same(urls,actual,"referenced and packaged media")
    proof = {}
    for url in sorted(urls):
        if not re.fullmatch(r"media/[a-z0-9-]+\.(mp4|webp)",url):
            raise ValueError(f"Invalid public media path {url}")
        file = out/url
        proof[url] = dict(bytes=file.stat().st_size,sha256=sha(file))
    return proof


def content_index(folder):
    return {p.relative_to(folder).as_posix():sha(p) for p in folder.rglob("*") if p.is_file()}


def build(kit, target, issue, revision, title):
    art, tech = kit/"给美术", kit/"制作记录"
    ledger = load(tech/"动作台账.json")
    checked = load(tech/"同屏总览核对.json")
    rows = ledger["actions"]
    assert_same([r["id"] for r in rows],[r["id"] for r in checked["actions"]],"ledger and board entries")
    assert_same(len({r["id"] for r in rows}),len(rows),"unique action numbers")
    inc_scene = bool(checked["context"])
    geo = read_geometry(kit)
    rates = tuple(Fraction(str(ledger[key])) for key in ("rate","sourceRate","gameRate"))
    if min(rates)<=0 or issue<1 or not re.fullmatch(r"r[1-9][0-9]*",revision):
        raise ValueError("Review identity or board rate is invalid")
    target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="review-export-",dir=target.parent) as temp:
        stage = Path(temp)/"version"
        (stage/"media").mkdir(parents=True)
        with ThreadPoolExecutor(max_workers=4) as pool:
            boards = [pool.submit(overview,art,stage,key,layout,geo,rows,checked["layouts"][layout.name],inc_scene)
                      for key,layout in [("wide",geo.WIDE),("tall",geo.TALL)]]
            moves = list(pool.map(lambda row: move_record(row,art,stage,rates), rows))
            layouts,checks = {},{}
            for task in boards:
                key,desc,probe = task.result()
                layouts[key] = desc
                checks[key] = probe
        if inc_scene:
            moves.append(context_record(kit,art,stage))
        manifest = dict(schema=1,issue=issue,revision=revision,fps=float(geo.FPS),
                        title=title,assetCommit=ledger["game"]["commit"],layouts=layouts,moves=moves)
        files = verify_urls(stage,manifest)
        (stage/"manifest.json").write_bytes(json_bytes(manifest))
        proof = dict(schema=1,issue=issue,revision=revision,assetCommit=manifest["assetCommit"],
                     moves=len(moves),mediaFiles=len(files),layouts=checks,media=files,
                     manifestSha256=sha(stage/"manifest.json"))
        if target.exists():
            assert_same(content_index(target), content_index(stage),"immutable revision already exists")
        else:
            os.replace(stage,target)
        audit = target.parent/(revision+"-export-check.json")
        report = Path(temp)/audit.name
        report.write_bytes(json_bytes(proof,readable=True))
        os.replace(report,audit)
    print(json.dumps(dict(output=str(target),moves=len(moves),mediaFiles=len(files),
                          bytes=sum(v["bytes"] for v in files.values()),layouts=checks,
                          manifestSha256=proof["manifestSha256"]),ensure_ascii=False))


if __name__=="__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("kit",type=Path,help="Kit containing 给美术 and 制作记录")
    cli.add_argument("out",type=Path,help="Immutable public revision directory")
    cli.add_argument("--issue",type=int,required=True)
    cli.add_argument("--revision",required=True)
    cli.add_argument("--title",default="教官全动作校对")
    options=cli.parse_args()
    build(options.kit.resolve(),options.out.resolve(),options.issue,options.revision,options.title)
