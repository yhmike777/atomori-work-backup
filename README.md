# Atomori 巡检控制台

当前版本：**2026-10-28 20:51:55 完整源码**，于 2026-10-29 同步到 GitHub。前端、后端、三维模型、离线手势资源、测试源码及机端/车端部分部署存档均已包含。

## 直接下载完整代码（推荐）

**[下载完整 ZIP：Atomori-source-20261028-205155.zip](https://github.com/yhmike777/atomori-work-backup/releases/download/atomori-20261028-205155/Atomori-source-20261028-205155.zip)**

也可进入 [版本下载页面](https://github.com/yhmike777/atomori-work-backup/releases/tag/atomori-20261028-205155)，在 Assets 中下载上述 ZIP。该文件是用户提供的原始完整代码包，约 188 MB，包含实际 GLB 模型和离线识别资源。解压整个目录并保持目录结构。

SHA256：`cf53a13552395cdd372c5407e5f6d75a3906f94e7d58306ad6427a197c3d8460`

仓库里的 GLB 使用 Git LFS；GitHub 绿色 Code 按钮下的 Download ZIP 可能只含模型指针。需要完整模型时，请优先下载上方 Release 附件。

## 快速打开本地页面

安装 Node.js 20 或更高版本。前端已构建，直接运行无需安装 npm 依赖。解压后，在代码根目录打开 PowerShell，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\打开前端-离线.ps1'
```

浏览器打开 <http://127.0.0.1:3003/marp/巡检控制台.html>。端口占用时添加 `-Port 3004`，再打开对应端口。离线入口清空设备来源，没有接入的传感器字段保持为空。

## H100 无人机模式

电脑通过 H100 可访问无人机，并已在专用网卡上配置同网段、未占用的 IPv4 地址后，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\启动当前H100无人机.ps1'
```

默认端口 3003，小车保持断开；无人机飞控 `192.168.50.3:8768`、视觉 `:8765`、A8 图传 `:8870`。入口不配置网卡，也不发送飞行控制命令。源码中的历史设备状态只代表当时记录，连接前需重新确认。

## 本次更新

- 无人机总览及飞控详情弱网显示约每秒更新，保留最近有效值和完整画面，断网后自动恢复，样本年龄与真实连接状态独立显示。
- 修复姿态源切换，视觉状态优先使用轻量 `/api/vision`，隐藏页面暂停轮询。
- 包含飞控全量遥测桥、H100 A8/OV9281 图传、传感器页面、三维模型和摄像头手势资源。

实际源码在 `source/Atomori-巡检控制台源码/`。机端飞控桥 `backend/device/flight_status_http.py` 与 `flight_telemetry.py` 必须一起使用。`机端部署文件/` 和 `车端部署文件/` 是部分部署存档，完整设备环境还需要 ROS、容器、硬件及原设备工程；车端弱网补丁尚未部署。

原始包的详细说明见 [00-最新代码包说明.md](00-最新代码包说明.md)。历史说明保留在 [使用说明.md](使用说明.md)、[交接说明.md](交接说明.md) 和源码目录的 `AGENTS.md`，当前入口以上文为准。

## 通过 Git 获取源码

安装 Git LFS 后运行：

```powershell
git lfs install
git clone https://github.com/yhmike777/atomori-work-backup.git
cd atomori-work-backup
git lfs pull
```

模型 `source/Atomori-巡检控制台源码/assets/product-viewer/ugv.glb` 应为 124,121,768 字节。重新构建三维页面需要 Node.js 20.19+ 或 22.12+，在 `product-viewer` 中执行 `npm ci`、`npm run build`。

## 验证

后端目录运行 `node --test`；机端桥离线测试在 `backend/device` 运行 `python -m unittest test_flight_status_http test_flight_telemetry`。源码包的 `MANIFEST.sha256.json` 提供文件校验值；GitHub 版本为本页说明及 Windows PowerShell UTF-8 BOM 兼容调整重新生成清单。原始 Release 附件保持原始字节。

不包含依赖目录、虚拟环境、SSH 密钥、密码、运行日志或当前 `.runtime` 数据。上游设备工程：[SmallH0433/UAV-CAR](https://github.com/SmallH0433/UAV-CAR)。
