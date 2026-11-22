# 动作校对页

每张需要美术校对的主仓 Issue 使用一个固定入口。打开 [教官 #335](https://flashnightmodreborn.github.io/cf7-evidence/review/335/) 可在一屏看全本轮动作，[R1 的 U19](https://flashnightmodreborn.github.io/cf7-evidence/review/335/r1/#U19) 是固定画面的例子。

点任一动作，在视频下写评论，点「用 GitHub 账号发表」。首次在 GitHub 确认后，网页会回到同一招、同一拍，自动发表刚才的文字。下次在同一浏览器打开页面，直接点「发表评论」即可。其他已打开的校对标签页也会同步登录或退出。反馈以公开的 GitHub 用户名署名。点历史时间可回看当时的画面。联通测试使用独立记录分组。

## 发布一个版本

将有版本号的媒体清单和素材导出到新目录。清单列出稳定动作号、动作内容的 SHA-256、原稿配对情况、可选反馈、时长和两种总览布局。在证据仓根目录执行以下命令。

```powershell
python -X utf8 review/tools/export_review_media.py $kit $bundle --issue 335 --revision r1 --title 教官全动作校对
python -X utf8 review/tools/publish_round.py $bundle --api https://cf7-art-review-receipts.crazyfs.chatgpt.site
```

新单默认启用 GitHub 账号评论。需要早期私发链接或独立联通测试时，可在首次发布命令后加 `--new-invites $privateDirectory`，私有目录须位于仓库和素材目录之外。后续轮次沿用已有授权。将本轮目录、校对页和最新轮次指针一起提交至本仓 main。新画面用 r2、r3 等新目录，便于以前的回执始终找到原视频。

## 按轮汇总

```powershell
python -X utf8 review/tools/round_summary.py 335 --revision r1
```

制作确认后加 `--post`，以当前维护者身份更新该轮的一条主仓 Issue 评论。汇总只读取实际美术反馈。证据站提供公开媒体和版本数据，回执服务校验账号、校对单及本轮画面，并保存每次反馈。

主仓的「美术校对回执」工作流可以指定单号和轮次运行；带校对标记的 Issue 关闭时，它会汇总最新轮次。历史页面和回执可继续查阅。R1 的[公开联通验收](../dev-evidence/issue-335-art-review/r1-live.json)记录了填写端与只读端的实际回读。

回执服务使用独立的 Worker 和 D1。首次启用 GitHub 登录，由组织管理员[确认身份应用](https://cf7-art-review-receipts.crazyfs.chatgpt.site/github-auth/setup)。应用只读取 GitHub 公开身份，客户端密钥由服务端封装保管；回执服务只向页端签发自己的限期会话。部署处理器和 SQL 在 `service/`，可用 Node 24 运行 `node --test review/service/*.test.mjs` 核对账号回调、重复提交、并发改选和新版复看。新 Issue 按单号复用同一服务。
