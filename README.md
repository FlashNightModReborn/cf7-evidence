# CF7:FlashNight 独立证据仓库 (`cf7-evidence`)

本仓库用于集中归档 `FlashNightModReborn/CrazyFlashNight` 的现场诊断日志、录屏抽帧与专项工程验证证据，避免大体积二进制或日志派生物膨胀主代码仓库，同时保证所有 Issue 证据均位于 `https://github.com/FlashNightModReborn/cf7-evidence` 官方域名下，支持各类自动化 Agent 直接拉取与 SHA-256 校验。

## 目录隔离规范

1. **`test-evidence/`（测试与社群反馈证据区）**
   - 由测试群机器人（银色大肥龙）或测试员自动归档。
   - 按 `test-evidence/issue-<编号>/file-<ID>-<文件名>/` 组织，内含：
     - `manifest.json`：原件与脱敏副本的字节数、行数、SHA-256 及包内文件哈希清单；
     - `fault_window_verbatim.txt`：带原始 `Lxxxxx` 行号的关键故障时窗完整原文；
     - `*-evidence.zip`：包含完整脱敏日志（`launcher.redacted.log`）、关键时窗原文与 `manifest.json` 的标准压缩包。
2. **`dev-evidence/`（开发与专项工程验收证据区）**
   - 存放开发自测、性能基线、专项回执与回归复验证据包，支持主仓库按需通过 Git Submodule 只读挂载。
