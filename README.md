# Atomori 巡检控制台

以 2026-10-27 22:25 的代码包为基础，已更新至 2026-10-28，包含按钮精简、手势识别修复、H100 双路实时图传启动入口，以及车端和机端相机服务存档。实际源码位于 `source/Atomori-巡检控制台源码`。详细操作见 [使用说明.md](使用说明.md)。

## 下载完整代码

三维模型约 124 MB，使用 **Git LFS** 保存。请安装 [Git LFS](https://git-lfs.com/)，然后运行：

```powershell
git lfs install
git clone https://github.com/yhmike777/atomori-work-backup.git
cd atomori-work-backup
git lfs pull
```

推荐使用上述方式获取完整模型；GitHub 的 Download ZIP 可能仅包含 LFS 指针文件。模型下载完成后，`source/Atomori-巡检控制台源码/assets/product-viewer/ugv.glb` 应约为 124 MB。

## 快速打开页面

需要 Node.js 20.19+ 或 22.12+（推荐满足要求的 LTS 版本）。前端及三维资源已构建，无需安装 npm 依赖即可运行。在仓库根目录打开 PowerShell：

```powershell
$env:PORT = '3001'
$env:ATOMORI_LIVE_ONLY = 'true'
$env:ATOMORI_CAR_URL = ''
$env:ATOMORI_UAV_VISION_URL = ''
$env:ATOMORI_UAV_FLIGHT_URL = ''
$env:ATOMORI_MISSION_PLANNER_URL = ''
node '.\source\Atomori-巡检控制台源码\backend\src\server.js'
```

浏览器打开 <http://127.0.0.1:3001/marp/巡检控制台.html>。此方式不连接设备；没有真实来源时遥测显示为空。端口占用时修改 `PORT` 并使用对应地址。

## 实时设备模式

### 2026-10-28：本机当前使用 H100 实时图传

电脑网线连接 H100，当前有线地址为 `192.168.50.10/24`。在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\启动H100实时图传.ps1'
```

页面地址为 <http://127.0.0.1:3001/marp/巡检控制台.html>。小车前视通过 `192.168.50.2:8765` 读取；无人机 A8 可见光由车端网关转发 `192.168.50.3:8870`，均使用 H100 网段。本次已在页面显示并验证两路持续更新的图像。

此入口使用原 `.runtime/records.json`，默认只配置车端网关，A8 经该网关转发；无人机飞控、OV9281 和 Mission Planner 的地址默认为空，需要时通过对应参数显式配置。它不自动启动 Mission Planner。OV9281 下视服务尚未就绪，默认不配置下视视频。启动前应关闭已占用 3001 的旧实例，或用 `-Port` 选择其他端口。

当前电脑有线地址为临时 ActiveStore 配置，重启后可能需要重设；脚本发现没有 `192.168.50.*` 地址时会停止并提示。其他电脑接入时，也需要在连接 H100 的网卡上配置同网段、未占用的地址，不添加网关。

机端 A8 修复源码、服务定义、备份恢复方式和离线测试见 [机端部署文件](机端部署文件/README.md)。这是既有设备环境的部分部署存档；完整复现还需要车端网关、A8 原工程和相机网络。

### 原 Mission Planner / Wi-Fi 启动方式

首次使用 Mission Planner 接收器时，需要 Python 3，并安装接收器依赖：

```powershell
cd '.\source\Atomori-巡检控制台源码\backend'
python -m venv .venv-mavlink
.\.venv-mavlink\Scripts\python.exe -m pip install -r device\requirements-mission-planner.txt
```

返回仓库根目录后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\启动最新版-实时巡检.ps1'
```

默认端口为 3001，默认断开小车；机载地址使用 `uavpi.local`，Mission Planner 接收源默认 `192.168.1.7`、UDP 14551。换电脑时应修改 Mission Planner 转发目标并允许对应端口入站。新鲜心跳才表示飞控在线。业务记录首次从包内快照复制到 `.runtime/records.json`，之后在该文件中独立保存。

该旧入口默认断开小车。需要通过 Wi-Fi 重连且确认小车已上电时，使用 `& '.\启动最新版-实时巡检.ps1' -DisconnectCar:$false`。2026-10-28 已按用户要求接通 H100 双路图传，当前请优先使用上节 H100 入口。历史入口 `启动最新版-仅无人车.ps1` 为旧配置。

## 本次更新

- 旋转、复位、全屏改为图标按钮，保留悬停提示和无障碍名称。
- 手势稳定判定兼容较慢推理及短时置信度/朝向波动，摄像头按钮下方显示识别结果与提示。
- H100 双路真实视频入口及机端 A8 解码器超时、旧帧和断流清理修复。
- 三维展示、结构展开、零件选择、手势资源及控制台布局。
- UGV 4 小时电量估算、前视连续 MJPEG 与图传健康判断。
- 温湿度实时有效期和上次有效读数标记；失联清空旧数据。
- Mission Planner 显式选源与无人机视频连接门控。
- 车端位置保留摇杆、相机短暂解码失败重试，以及对应测试。

`车端部署文件/` 和 `机端部署文件/` 是已部署文件的部分存档；重新部署前先核对并备份设备现有文件。当前设备状态和历史约定见源码目录内的 `AGENTS.md`。旧交接记录保留在 [交接说明.md](交接说明.md)。上游设备工程为 [SmallH0433/UAV-CAR](https://github.com/SmallH0433/UAV-CAR)。

## 修改与验证

后端：在 `source/Atomori-巡检控制台源码/backend` 运行 `node --test`。

三维展示：在 `source/Atomori-巡检控制台源码/product-viewer` 运行 `npm ci`、`npm run build`、`npm test`。

车端摇杆隔离验证：在 `source/Atomori-巡检控制台源码` 运行 `node --test vehicle-ui/test-a2-joystick.mjs`。

机端 A8 恢复隔离验证：在仓库根目录运行 `python "机端部署文件/tests/test_a8_recovery.py"`，无需访问设备。

仓库不包含依赖目录、虚拟环境、运行日志、SSH 密钥或密码。

## 历史备份说明（2026-10-26 及更早）

以下为旧版本记录，当前启动方式与默认行为以本文上方和《使用说明.md》为准。

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
