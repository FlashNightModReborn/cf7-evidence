# 动作校对页

每张需要美术校对的主仓 Issue 使用一个固定入口。打开 [教官 #335](https://flashnightmodreborn.github.io/cf7-evidence/review/335/) 可在一屏看全本轮动作，[R1 的 U19](https://flashnightmodreborn.github.io/cf7-evidence/review/335/r1/#U19) 是固定画面的例子。

公开链接可看画面、标记和历史。美术使用私下收到的专属链接即可点选，服务端回执到达后才显示「已记录」。播放位置和可选备注随记录保存；点错可以改选或撤回。点历史中的时间可以打开当时那一版、那一拍。未改素材可以沿用意见，发生变化的动作显示「复看」。技术联通测试使用独立记录分组。

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
