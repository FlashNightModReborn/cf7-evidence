"""Print a review round's public art summary. --post maintains one comment per round."""
import argparse
import json
import os
import re
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen

LABELS={"match":"对得上","mismatch":"对不上","unclear":"看不清","use":"用左边这版","other":"指的是别的稿",
        "yes":"是这招","no":"不是这招","clear":"撤回","comment":"文字评论"}
REPO="FlashNightModReborn/CrazyFlashNight"
PAGES="https://flashnightmodreborn.github.io/cf7-evidence/review/"


def get(url):
    with urlopen(Request(url,headers={"Accept":"application/json","User-Agent":"CF7-review-summary"}),timeout=20) as result:
        return json.load(result)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("issue",type=int)
    p.add_argument("--revision",help="Defaults to the published latest revision")
    p.add_argument("--post",action="store_true",help="Use current gh identity to create/update the human review summary")
    p.add_argument("--skip-unregistered",action="store_true",help="For issue closure events without a published review")
    args=p.parse_args()
    base=PAGES+str(args.issue)+"/"
    try:entry=get(base+"latest.json")
    except HTTPError as error:
        if error.code==404 and args.skip_unregistered:
            print("此 Issue 没有已发布的校对页");return
        raise
    if entry["issue"]!=args.issue:raise ValueError("校对单身份不一致")
    revision=args.revision or entry["revision"]
    if not re.fullmatch(r"r[1-9]\d*",revision):raise ValueError("轮次无效")
    api=entry["api"]
    if not re.fullmatch(r"https://[a-z0-9.-]+",api):raise ValueError("回执源无效")
    manifest=get(base+revision+"/manifest.json")
    if manifest["issue"]!=args.issue or manifest["revision"]!=revision:raise ValueError("轮次清单身份不一致")
    moves={m["id"]:m for m in manifest["moves"]}
    decisions={}; notes={}; cursor=0
    while True:
        batch=get(api+"/api/v1/reviews/"+str(args.issue)+"/events?"+urlencode({"after":cursor}))
        for e in batch["events"]:
            cursor=e["seq"]
            if int(e["revision"][1:])>int(revision[1:]) or e["action"] not in moves:continue
            key=(e["action"],e["author"])
            if e["choice"]=="clear":
                decisions.pop(key,None);notes.pop(key,None)
            elif e["asset"]==moves[e["action"]]["version"]:
                if e["choice"]=="comment":notes[key]=e
                else:decisions[key]=e
            else:
                decisions.pop(key,None);notes.pop(key,None)
        if not batch["more"]:break
    current=list(decisions.values())+list(notes.values())
    counts=Counter(e["choice"] for e in current)
    marker=f"<!-- cf7-art-round:{args.issue}:{revision} -->"
    lines=[f"## {revision.upper()} 美术校对汇总","",f"[本轮画面与原始反馈]({base}{revision}/)","",
           f"已有 {len({e['action'] for e in current})} 项收到与本轮素材对应的美术反馈。"]
    if counts:lines.extend([""," · ".join(f"{LABELS[k]} {n}" for k,n in counts.items())])
    for e in sorted(current,key=lambda x:(x["action"],x["seq"])):
        if e["choice"] in {"mismatch","other","unclear","no","comment"}:
            at=f"{base}{e['revision']}/?t={e['positionMs']}#{e['action']}"
            lines.append(f"- [{e['action']} {moves[e['action']]['name']}]({at})　{LABELS[e['choice']]}")
    lines.extend(["",marker,""])
    body="\n".join(lines)
    if not args.post:print(body);return
    login="github-actions[bot]" if os.environ.get("GITHUB_ACTIONS")=="true" else subprocess.check_output(["gh","api","user","--jq",".login"],text=True).strip()
    comments=json.loads(subprocess.check_output(["gh","api","--paginate","--slurp",f"repos/{REPO}/issues/{args.issue}/comments"],encoding="utf8"))
    alternatives=[c for page_ in comments for c in page_ if marker in c["body"] and
                  (c["user"]["login"] in (login,"github-actions[bot]") or c.get("author_association") in ("OWNER","MEMBER","COLLABORATOR"))]
    if len(alternatives)>1:raise ValueError("发现重复的轮次汇总，请先核对")
    with tempfile.TemporaryDirectory() as tmp:
        if alternatives:
            if alternatives[0]["body"].strip()==body.strip():print(alternatives[0]["html_url"]);return
            file=Path(tmp)/"comment.json";file.write_text(json.dumps({"body":body},ensure_ascii=False),"utf8")
            subprocess.run(["gh","api","--method","PATCH",f"repos/{REPO}/issues/comments/{alternatives[0]['id']}","--input",str(file),"--jq",".html_url"],check=True)
        else:
            file=Path(tmp)/"comment.md";file.write_text(body,"utf8")
            subprocess.run(["gh","issue","comment",str(args.issue),"--repo",REPO,"--body-file",str(file)],check=True)


if __name__=="__main__":
    main()
