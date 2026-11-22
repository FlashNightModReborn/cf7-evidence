# 动作校对页

每张需要美术校对的主仓 Issue 使用一个固定入口。打开 [教官 #335](https://flashnightmodreborn.github.io/cf7-evidence/review/335/) 可在一屏看全本轮动作，[R1 的 U19](https://flashnightmodreborn.github.io/cf7-evidence/review/335/r1/#U19) 是固定画面的例子。

点任一动作，视频下面有「写评论」输入框和「发表评论」。在手机或电脑上点入输入框会暂停画面，评论带上该时刻。文字可以单独发表，已有的动作判断仍可回看。公开链接可以先写草稿，再在原处粘贴本单专属填写链接。美术直接打开专属链接即可发表，也可只点一个判断。服务端确认后才显示「已保存」。点历史时间可回到当时那一版、那一拍。技术联通测试使用独立记录分组。

## 发布一个版本

将有版本号的媒体清单和素材导出到新目录。清单列出稳定动作号、动作内容的 SHA-256、原稿配对情况、可选反馈、时长和两种总览布局。下列命令在证据仓根目录执行。私有目录需放在仓库和素材目录之外。

```powershell
python -X utf8 review/tools/export_review_media.py $kit $bundle --issue 335 --revision r1 --title 教官全动作校对
python -X utf8 review/tools/publish_round.py $bundle --api https://cf7-art-review-receipts.crazyfs.chatgpt.site --new-invites $privateDirectory
```

初次发布生成美术和联通测试两条独立链接，公开的 policy.json 仅保存随机令牌的 SHA-256。再次发布保留现有授权。需轮换时替换对应摘要并私下交付新链接。将本轮目录、校对页和最新轮次指针一起提交至本仓 main。新画面用 r2、r3 等新目录，便于以前的回执始终找到原视频。

## 按轮汇总

```powershell
python -X utf8 review/tools/round_summary.py 335 --revision r1
```

制作确认后加 `--post`，以当前维护者身份更新该轮的一条主仓 Issue 评论。汇总只读取实际美术反馈。证据站提供公开的只读媒体和版本数据，写入接口通过专属链接校验这一单的权限，并把每次变更存入独立的回执数据库。

主仓的「美术校对回执」工作流可以指定单号和轮次运行；带校对标记的 Issue 关闭时，它会汇总最新轮次。历史页面和回执可继续查阅。R1 的[公开联通验收](../dev-evidence/issue-335-art-review/r1-live.json)记录了填写端与只读端的实际回读。

回执服务使用独立的 Worker 和 D1。部署版本的处理器和建表 SQL 在 `service/`，可使用 Node 24 运行 `node --test review/service/reviews.test.mjs` 核对权限、重复提交、并发改选和新版复看。新 Issue 使用同一服务，按单号从本仓的 policy.json 读取授权和版本。
