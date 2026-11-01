# v0.4.8 发布与维护

发行仓库：[xie8266509/agentid-sniper-web](https://github.com/xie8266509/agentid-sniper-web)。当前正式发行 **v0.4.8（2026-11-01）**，同步上游 v2.8.2，加入闲时安装、上游检测及审核后自动发行，保留更新器时差修复及多钱包工作台；历史保留在 [变更记录](CHANGELOG.md)。线上提交、CI 和发行结果分别以仓库页面为准。

## 归属与发行方式

- 原项目：[Nancy / Agent ID Sniper](https://github.com/nancyc0813-maker/agentid-sniper)，原作者 [@nancy_c813](https://x.com/nancy_c813)。
- 社区 Web 增强版维护：[@supra_bnb](https://x.com/supra_bnb)。Web 页脚、README 和 NOTICE 已标注双方来源。
- 保留 `LICENSE` 中 Nancy 的 MIT 版权与完整许可；保留 `lib/vendor/element-sdk-LICENSE` 和 ABI 来源提交。不替换原作者版权。
- 首个增强版版本为 `v0.1.0`，当前正式版为 `v0.4.8`；上游基线单独记录为 `v2.8.2 / ef74121`。
- 发行目标是 GitHub，`package.json` 的 `private: true` 可保留。

## 执行清单

| 工作 | 当前状态 | 最终验收 |
| --- | --- | --- |
| Web 署名与来源 | 已准备 | 原作者与增强版维护者链接正确，原许可保留。 |
| 首页、使用、贡献与安全反馈文档 | 已准备 | 干净克隆按 README 完整走通；无本机文件链接或伪造联系方式。 |
| 更新渠道与完整发行清单 | 本地验证通过 | 用户只跟随增强版正式发布标签与 `release.json`；校验 Web、钱包、NFT 等完整发行内容，更新与回退不覆盖数据。 |
| 源码收齐、忽略规则与敏感信息检查 | 已知模式检查通过 | 首个提交包括增强版完整源码；完整历史和发布候选检查通过，不含配置、会话、Key 或日志。 |
| CI、干净安装与升级/回退回归 | 本地验证通过 | Node.js 24 离线测试及 macOS 安装验证通过，不使用真实钱包或交易权限。 |
| 发行提交与标签 | [查看正式发行](https://github.com/xie8266509/agentid-sniper-web/releases) | `v0.4.8` 正式标签对应发行清单与通过检查的源码。 |
| GitHub Fork、线上 CI 与 Release | [发行仓库](https://github.com/xie8266509/agentid-sniper-web) | [线上 CI](https://github.com/xie8266509/agentid-sniper-web/actions) 与 Release 记录可核对；发行内容必须与已验证源码一致。 |

## 更新渠道

`origin` 指向增强版发行仓库，`upstream` 指向 Nancy 的原项目。每 15 分钟目标频率自动生成固定差异和适配清单的 Draft PR；维护者完成兼容修改、审核并合入后，以 main 完整 SHA 运行 `Publish reviewed release` 自动验证和发布；用户不会直接安装原作者仓库的扫描器单文件。

用户一键更新绑定增强版正式发布标签和完整 `release.json` 文件清单。增强版版本和上游基线分别显示。每次发行均须检查发布清单、候选代码、源码变动保护、数据保留、备份与失败回退。

## 支持边界

- 已验证环境以 macOS 和 Node.js 24 为准；最低 Node.js 22.15，Git 必需。Linux/Windows 的增强版后台服务尚未完成验证。
- 使用 `git clone` 安装；Download ZIP 缺少 `.git`，暂无一键更新保证。旧 Windows 根目录入口已停用，原始安装/启动脚本保存在 `docs/legacy/*.txt`；`setup.mjs` 已改为安全只读初始化兼容入口。
- 首次配置保持只读模式、空钱包、零每日付费预算。自动交易必须由用户登录并核对规则后明确开启。
- 多钱包测试不代表已验证 2–3 个真实币安账号同时在线实盘；新增钱包默认只监控、不勾选暂停，不自动启用交易；已有的手动暂停状态保持不变。
- NFT 自动卖出依赖 Element API Key/权限；无有效买单时等待。真实挂牌和成交尚未完成完整实盘验证，不宣传为已验证盈利或保证成交。
- 首发不引用本机 `data/` 截图；公开截图需另外生成，先检查钱包、日志和敏感信息。

## 发布排除项

`config.json`、整个 `data/`、钱包会话、市场 Key、运行日志、订单状态、更新备份、`node_modules/`、本机 CLI 安装目录和停止标记。首次公开提交前，额外核对 `.env`、密钥、备份和其他本机生成物，并检查 Git 历史。

文档已提供安全反馈入口的条件说明；若 GitHub 私密漏洞报告尚未启用，不引导用户公开敏感复现材料。维护者须持续核对该设置及 Issue 模板。

## 发行时间与客户端兼容

根据 [GitHub 最新正式发行接口](https://docs.github.com/en/rest/releases/releases#get-the-latest-release) 的发布状态确认正式 Release；`published_at` 须为有效 ISO 时间戳，但不与本机时间比较。固定 HTTPS 来源、禁止重定向、稳定标签、标签提交、全部文件哈希、版本与快进关系、候选验证和备份回滚继续执行。不要通过扩大一小时宽限或修改系统时间处理时差。

旧版（≤ v0.2.1）保留旧判断，新 Release 无法自动改变尚未升级的代码。遇到旧版拦截时按 [一次迁移说明](README.local.md#旧版更新器的一次迁移) 升级；本版及后续客户端无需等待发布时间。

## 发布后维护

按 [CONTRIBUTING.md](CONTRIBUTING.md) 接受变更，通过 [SECURITY.md](SECURITY.md) 处理敏感报告，并维护 [CHANGELOG.md](CHANGELOG.md)。同步上游时核对 `docs/UPSTREAM_README.md` 的历史来源和基线，不自动覆盖增强版首页。
