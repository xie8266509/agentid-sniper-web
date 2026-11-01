# v0.1.0 发布与维护

目标发行仓库：[xie8266509/agentid-sniper-web](https://github.com/xie8266509/agentid-sniper-web)。Fork 已创建；安装、发布清单及更新/回退已在隔离临时仓库验证。线上提交、CI 和发行结果分别以仓库页面为准。

## 归属与发行方式

- 原项目：[Nancy / Agent ID Sniper](https://github.com/nancyc0813-maker/agentid-sniper)，原作者 [@nancy_c813](https://x.com/nancy_c813)。
- 社区 Web 增强版维护：[@supra_bnb](https://x.com/supra_bnb)。Web 页脚、README 和 NOTICE 已标注双方来源。
- 保留 `LICENSE` 中 Nancy 的 MIT 版权与完整许可；保留 `lib/vendor/element-sdk-LICENSE` 和 ABI 来源提交。不替换原作者版权。
- 首个增强版版本为 `v0.1.0`；上游基线单独记录为 `v2.5.8 / 5bd5049`。
- 发行目标是 GitHub，`package.json` 的 `private: true` 可保留。

## 执行清单

| 工作 | 当前状态 | 最终验收 |
| --- | --- | --- |
| Web 署名与来源 | 已准备 | 原作者与增强版维护者链接正确，原许可保留。 |
| 首页、使用、贡献与安全反馈文档 | 已准备 | 干净克隆按 README 完整走通；无本机文件链接或伪造联系方式。 |
| 更新渠道与完整发行清单 | 本地验证通过 | 用户只跟随增强版正式发布标签与 `release.json`；校验 Web、钱包、NFT 等完整发行内容，更新与回退不覆盖数据。 |
| 源码收齐、忽略规则与敏感信息检查 | 已知模式检查通过 | 首个提交包括增强版完整源码；完整历史和发布候选检查通过，不含配置、会话、Key 或日志。 |
| CI、干净安装与升级/回退回归 | 本地验证通过 | Node.js 24 离线测试及 macOS 安装验证通过，不使用真实钱包或交易权限。 |
| 发行提交与标签 | [查看正式发行](https://github.com/xie8266509/agentid-sniper-web/releases) | 代码审查、发行清单及 CI 通过后，从验证过的提交发布 `v0.1.0`。 |
| GitHub Fork、线上 CI 与 Release | [Fork 已创建](https://github.com/xie8266509/agentid-sniper-web) | [线上 CI](https://github.com/xie8266509/agentid-sniper-web/actions) 通过后发布首版，发行内容必须与已验证源码一致。 |

## 更新渠道

`origin` 指向增强版发行仓库，`upstream` 指向 Nancy 的原项目。维护者在独立分支审查、合并上游变更，经 PR 和 CI 后发布增强版；用户不会直接安装原作者仓库的扫描器单文件。

用户一键更新绑定增强版正式发布标签和完整 `release.json` 文件清单。增强版版本和上游基线分别显示。发布校验、候选检查、源码变动保护、数据保留、备份与失败回退都须在首版发布前完成验证。

## 首发边界

- 已验证环境以 macOS 和 Node.js 24 为准；最低 Node.js 22.15，Git 必需。Linux/Windows 的增强版后台服务尚未完成验证。
- 使用 `git clone` 安装；Download ZIP 缺少 `.git`，暂无一键更新保证。旧 Windows 根目录入口已停用，原始安装/启动脚本保存在 `docs/legacy/*.txt`；`setup.mjs` 已改为安全只读初始化兼容入口。
- 首次配置保持只读模式、空钱包、零每日付费预算。自动交易必须由用户登录并核对规则后明确开启。
- NFT 自动卖出依赖 Element API Key/权限；无有效买单时等待。真实挂牌和成交尚未完成完整实盘验证，不宣传为已验证盈利或保证成交。
- 首发不引用本机 `data/` 截图；公开截图需另外生成，先检查钱包、日志和敏感信息。

## 发布排除项

`config.json`、整个 `data/`、钱包会话、市场 Key、运行日志、订单状态、更新备份、`node_modules/`、本机 CLI 安装目录和停止标记。首次公开提交前，额外核对 `.env`、密钥、备份和其他本机生成物，并检查 Git 历史。

文档已提供安全反馈入口的条件说明；若 GitHub 私密漏洞报告尚未启用，不引导用户公开敏感复现材料。仓库创建后应核对该设置及 Issue 模板。

## 发布后维护

按 [CONTRIBUTING.md](CONTRIBUTING.md) 接受变更，通过 [SECURITY.md](SECURITY.md) 处理敏感报告，并维护 [CHANGELOG.md](CHANGELOG.md)。同步上游时核对 `docs/UPSTREAM_README.md` 的历史来源和基线，不自动覆盖增强版首页。
