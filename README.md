# Atomori 巡检控制台工作备份

2026-10-13 从当前电脑工作目录保存的源码快照。实际项目位于 `source/Atomori-巡检控制台源码`。

## 2026-10-26 更新

已合入新版源码中的声音状态显示、顶部状态标签调整和「车端控制」子页面。完整交接信息见 [交接说明.md](交接说明.md)。

本次新增便携启动入口，在仓库根目录的 PowerShell 中运行 `./启动最新版-仅无人车.ps1`，默认仅连接无人车、关闭无人机连接；该入口与下文原有 `backend/start-connected.ps1` 的默认配置分开。运行需要 Node.js 20 或更高版本。图传及车辆实时数据需要电脑能够访问车端局域网地址。

## 内容

- 前端 HTML、CSS、JavaScript 与页面图片素材。
- Node.js 后端、业务记录 JSON、自动测试与开发验证脚本。
- 设备只读遥测桥、Mission Planner 桥及部署说明。
- 历史接入文档、车端地图和页面验证截图。

虚拟环境、Python 缓存、本机凭据、旧 ZIP 导出包和 `upstream` 中仅存的外部 Git 元数据不纳入备份。上游设备代码来源为 https://github.com/SmallH0433/UAV-CAR ，本仓库保存的是本地巡检控制台工作成果。

## 启动

安装 Node.js 20 或更高版本后，在 PowerShell 中执行：

```powershell
cd 'source/Atomori-巡检控制台源码/backend'
node src/server.js
```

打开 http://127.0.0.1:3000/ 。后端测试在同一目录运行 `node --test`。

设备连接配置见项目中的 `backend/README.md`。`backend/start-connected.ps1` 当前默认通过 `uavpi.local:8768` 连接无人机只读遥测，小车与视觉保持关闭。无人机 IP 可能为 `192.168.1.36` 或 `192.168.1.37`，一个不可达时可继续尝试另一个，登录后用 `hostname` 核对设备名 `uavpi`；主机名解析不可用时，使用 `-UavHost <已验证IP>` 启动。2026-10-21 实测为 `.37`，已验证网页读取到更新的飞控心跳和模式；电池、姿态、测距无有效值时保留 `—`。具体状态见项目 `AGENTS.md`。

标题旁的「产品展示」跳转到独立子页面 `marp/product-showcase.html`，目前保留制作中的占位内容，完成的产品页面可直接替换；接入方式见源码中的 `marp/产品展示接入.md`。无人机和小车侧栏在矮窗口中支持独立滚动，窄屏下完整展开并支持整页滚动。

`backend/data/records.json` 是当前本机业务记录的快照；记录属于演示任务或本机业务记录。真实设备控制仍关闭。
