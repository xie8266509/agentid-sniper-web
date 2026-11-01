# Agent ID Sniper Web

**v0.1.0 社区 Web 增强版**：在本机管理 Binance Agentic Wallet 的 Agent ID 铸造监控、持仓和卖出规则。

基于 [Nancy 的 Agent ID Sniper](https://github.com/nancyc0813-maker/agentid-sniper)。原作者 [@nancy_c813](https://x.com/nancy_c813)，Web 增强版维护 [@supra_bnb](https://x.com/supra_bnb)。这是社区维护项目，不是 Binance 官方产品。

## 功能

- Web 控制台：运行概览、钱包 App 登录、策略配置、持仓、手动预演与运行日志。
- 每个钱包使用独立的本地 CLI 会话，Web、登录脚本和扫描器共用同一隔离方式。
- ERC20 精确数量卖出、阶梯止盈与长抱；按订单和本笔链上凭证确认结果，未知结果停止自动重发。
- NFT 链上持仓核验、Element 参考地板价、固定价挂牌、目标净收入与跟踪止盈规则。
- Web 后台独立检查增强版更新，一键验证、备份、更新及回退；扫描器停止时仍能检查。

## 安装

**已验证：macOS、Node.js 24、Git。** 运行最低版本为 Node.js 22.15。Linux、Windows 尚未完成增强版验证，后台服务和一键更新依赖 POSIX 进程管理。

发行仓库：[xie8266509/agentid-sniper-web](https://github.com/xie8266509/agentid-sniper-web)。从 Git 仓库安装：

```sh
git clone https://github.com/xie8266509/agentid-sniper-web.git
cd agentid-sniper-web
npm ci
npm run setup
npm run web:start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。控制台只监听本机。

`setup` 会安装项目内的 Binance 官方 CLI，并在配置不存在时创建只读默认配置：空钱包、`monitorOnly: true`、每日付费预算为 `0`。已有配置会保留。启动 Web 不会自动启动扫描器或启用交易。

首次使用，在「钱包管理」获取配对链接，用对应币安 App 核对配对码并完成登录，再导入真实 BSC 地址。需要签名或交易时，在 App 的 Agentic Wallet 设置中开启开发者模式。项目不要求输入私钥或助记词。

首发使用 Git 克隆安装；Download ZIP 缺少 `.git`，不承诺一键更新可用。根目录的旧 Windows 安装/启动入口已停用，只显示支持范围和 README 提示；原脚本已作为不可执行的文本归档于 [docs/legacy](docs/legacy/)。这些入口不会安装依赖、启动扫描器或执行交易。

## 启用策略

先在 Web 核对钱包、单项目和每日预算，再明确启动自动模式。自动模式会按保存的规则发送链上交易；只读模式不执行自动铸造或买卖。首次 NFT 规则保存为停用草稿，启用和初次授权需要单独确认。

NFT 自动卖出需要具备相应权限的 [Element API Key](https://element.market/naas)，钱包须可用并满足预演要求。目前支持 BSC ElementEx 普通固定价挂牌和可完整核验的单品 WBNB 买单（收入按已验证编码可为 BNB 或 WBNB）；未知编码、额外授权或无法核验的结果会暂停。没有有效买单时等待，不用地板价代替可成交报价。**NFT 真实挂牌与成交尚未完成完整实盘验证。**

金额、预算、风险和当前支持范围见 [本地使用说明](README.local.md)。

## 更新与回退

「系统更新」随 Web 后台运行，启动时及每 30 分钟检查增强版的正式发布标签和 `release.json` 完整文件清单；安装由用户点击触发。发行仓库尚未配置时，不安装未知来源的代码。

更新前停止扫描器并完成钱包/NFT 操作。候选版本通过校验和本地回归检查后，保存备份、应用代码并重启 Web；启动验证失败时尝试恢复旧代码。回退不恢复或覆盖钱包会话、配置、持仓和订单数据，也不会自动开启交易。冲突、发布校验不一致或更新期间出现外部源码改动时会停止并显示原因。

Nancy 上游变更由维护者在独立分支合并，经审核和 CI 后发布增强版；用户更新不直接覆盖为上游的 `watch.mjs`。增强版版本和上游基线分别记录。

## 管理命令

```sh
npm run web:status
npm run web:stop
npm run monitor:status
npm run monitor:stop
npm test
```

建议通过 Web 明确启动扫描器。退出登录或重启电脑后，按需重新启动 Web；首次发行不配置系统开机自动运行。

## 本机数据

`config.json`、`data/`、钱包会话、市场 Key、运行日志、订单状态和更新备份均保存在本机，并被 Git 忽略。不要把这些文件或未脱敏日志提交到 Issue、PR 或仓库。保留订单状态文件，不要通过删除它来重试结果不明的交易。

## 贡献与许可

- [贡献说明](CONTRIBUTING.md) · [安全反馈](SECURITY.md) · [变更记录](CHANGELOG.md)
- [发布准备状态](README.opensource.md) · [上游 README 历史快照](docs/UPSTREAM_README.md)
- 本项目沿用 [MIT License](LICENSE)，保留 Nancy 的原始版权与许可；Element ABI 的第三方许可见 [NOTICE](NOTICE) 和 [Element SDK License](lib/vendor/element-sdk-LICENSE)。
