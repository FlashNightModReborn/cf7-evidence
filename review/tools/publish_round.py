"""Install one immutable review round and point its Issue's stable entry at it."""
import argparse
import hashlib
import html
import json
import re
import secrets
import shutil
from pathlib import Path
from urllib.parse import urlsplit


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_grant(directory,issue,lane):
    directory.mkdir(exist_ok=True,parents=True)
    token_file=directory/f"{issue}-{lane}.key"
    if not token_file.exists():
        with token_file.open("x",encoding="ascii") as stream:
            stream.write(secrets.token_urlsafe(32))
    key=token_file.read_text(encoding="ascii")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{43}",key):
        raise ValueError("校对密钥格式错误")
    authority={"lane":lane,"author":"美术校对" if lane=="art" else "联通测试",
               "digest":hashlib.sha256(key.encode("ascii")).hexdigest()}
    url=f"https://flashnightmodreborn.github.io/cf7-evidence/review/{issue}/"
    url+=("?qa=1" if lane=="qa" else "")+"#invite="+key
    (directory/f"{issue}-{lane}-link.txt").write_text(url+"\n",encoding="utf-8")
    return authority


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle",type=Path,help="Directory containing manifest.json and its media")
    parser.add_argument("--api",required=True,help="Public HTTPS origin of the receipt API")
    parser.add_argument("--new-invites",type=Path,help="Private output directory for the first round of a new issue")
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    source=args.bundle.resolve(strict=True)
    data=read(source/"manifest.json")
    issue=data["issue"];revision=data["revision"]
    if not isinstance(issue,int) or issue<1 or not re.fullmatch(r"r[1-9]\d*",revision):
        raise ValueError("校对单或轮次无效")
    origin=urlsplit(args.api)
    if origin.scheme!="https" or not origin.hostname or origin.username or origin.password or origin.path.strip("/") or origin.query or origin.fragment:
        raise ValueError("API 地址必须是 HTTPS 源")
    api=f"https://{origin.netloc}"
    holder=root/str(issue);version=holder/revision
    holder.mkdir(exist_ok=True)
    registry=holder/"policy.json"
    previous=read(registry) if registry.exists() else None
    if previous and int(revision[1:])<int(previous["revision"][1:]):
        raise ValueError("现用入口不能退回旧轮次")
    if previous:
        grants=previous["grants"]
    else:
        if not args.new_invites:raise ValueError("首次发布需要私下交付校对链接的目录")
        vault=args.new_invites.resolve()
        if vault.is_relative_to(root.parent) or vault.is_relative_to(source):
            raise ValueError("填写链接需存放在仓库和公开素材之外")
        grants=[make_grant(vault,issue,lane) for lane in ("art","qa")]
    keys=set()
    expected={"manifest.json"}
    for move in data["moves"]:
        key=move["id"]
        if key in keys or not re.fullmatch(r"[A-Z]\d{2}",key) or not re.fullmatch(r"[a-f0-9]{64}",move["version"]):
            raise ValueError("动作标识重复或无效")
        keys.add(key)
        expected.add(move["video"])
        if move.get("still"):expected.add(move["still"])
    for layout in data["layouts"].values():
        if set(layout["slots"])!=keys:raise ValueError("同屏热区与动作清单不符")
        expected.update((layout["movie"],layout["poster"]))
    if any(not re.fullmatch(r"media/[A-Za-z0-9_-]+\.(mp4|webp|png|gif)",name) for name in expected if name!="manifest.json"):
        raise ValueError("网页媒体需位于本轮 media 目录")
    bundle_files={file.relative_to(source).as_posix():file for file in source.rglob("*") if file.is_file()}
    if any(file.is_symlink() for file in source.rglob("*")) or "index.html" in bundle_files:
        raise ValueError("素材目录只接收已导出的清单和媒体")
    if set(bundle_files)!=expected:raise ValueError("素材包与公开清单不一致")
    for name,file in bundle_files.items():
        dest=version/name
        if dest.exists() and digest(dest)!=digest(file):
            raise ValueError("已发布轮次不能覆盖，需建立新轮次 "+name)
    for name,file in bundle_files.items():
        dest=version/name
        if not dest.exists():
            dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(file,dest)
    template=(root/"tools/page.html").read_text(encoding="utf8")
    for dest,app,base,media,round_name in [(holder,"../app/v2","./",revision+"/","latest"),(version,"../../app/v2","../","./",revision)]:
        page=template
        tags={"__ISSUE__":str(issue),"__TITLE__":data["title"],"__APP__":app,"__ROOT__":base,
              "__MEDIA__":media,"__ROUND__":round_name,"__DISPLAY__":revision.upper(),"__API_ORIGIN__":api}
        for marker,value in tags.items():page=page.replace(marker,html.escape(value,quote=True))
        (dest/"index.html").write_text(page,encoding="utf8")
    moves={m["id"]:{k:m[k] for k in ("version","durationMs","choices")} for m in data["moves"]}
    write_json(registry,{"issue":issue,"revision":revision,"moves":moves,"grants":grants})
    write_json(holder/"latest.json",{"issue":issue,"revision":revision,"api":api,"manifest":revision+"/manifest.json",
                                     "manifestSha256":digest(version/"manifest.json")})
    print(f"#{issue} {revision.upper()} · {len(keys)} 个可定位画面 · {len(bundle_files)} 份清单及媒体")


if __name__=="__main__":
    main()
