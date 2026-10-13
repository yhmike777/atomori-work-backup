# UAV-01 Mission Planner 实时遥测

控制台 UAV-01 旁的「飞控详情 ↗」进入 `/marp/uav-details.html`。页面保留飞行仪表、状态、健康检查和数据，不包含地图。

## 当前电脑迁移（2026-10-13）

- 当前接收电脑的 Wi-Fi 地址为 `192.168.1.45`。下面历史步骤中的 `192.168.1.9` 是旧电脑地址；Mission Planner 镜像目标应改为 `192.168.1.45:14551/UDP`。
- 用户确认 Mission Planner 电脑已连接飞控，Wi-Fi 为 `192.168.1.7`、以太网为 `192.168.1.10`。当前接收器按 Wi-Fi 来源 `192.168.1.7` 过滤；若网络实际从以太网发送，可按诊断中的来源地址重新启动为 `-SourceIp 192.168.1.10`。
- 旧 `.venv-mavlink` 仍引用旧电脑 Python 路径，已另建本机 `.venv-mavlink-local`。启动及网络脚本优先使用本机环境，保留原环境。
- 本机已运行只读接收器。管理员脚本 `enable-mission-planner-udp.ps1 -MissionPlannerIps 192.168.1.7,192.168.1.10 -PlatformIp 192.168.1.45` 仅放行指定来源的 UDP 14551，不修改网页的监听地址。
- 本机详情页为 `http://127.0.0.1:3000/marp/uav-details.html`。当前网页仅监听回环地址，另一台电脑不能用 `192.168.1.45:3000` 访问。
- 本机环境中的 6 项协议测试通过。跨电脑链路需在另一台电脑开启镜像后，以真实收包计数及飞控心跳确认；接收器启动不代表已收到飞控数据。
- 本次跨电脑链路已实测连通：`192.168.1.7` 转发到 `192.168.1.45:14551/UDP`，飞控 `SYS 1 / COMP 1`，接收器和同源 API 均报告在线；连续检查的有效消息计数从 10990 增加到 13472，浏览器详情页确认姿态、模式、心跳年龄及遥测自动刷新。本次检查模式为 STABILIZE、未解锁；电池电压原始上报 0 V、电量未知，不代表电池已测得有效电压或剩余电量。没有进行真实飞行或设备控制。

## 真实数据链路

Mission Planner 电脑 `192.168.1.7` → MAVLink Mirror → 本机 `192.168.1.9:14551/UDP` → Python 只读接收器 → `127.0.0.1:8770/api/status` → 同源 `/api/v1/devices/UAV-01/mission-planner` → 子页面。

- 子页面专门使用 Mission Planner 转发，不回退到树莓派接口或演示样本。
- PyMAVLink 校验 MAVLink 1/2 报文，拒绝错误 CRC；按指定源 IP 和首个飞控系统/组件锁定来源，忽略地面站心跳和其他飞控。
- 接口 `transport` 提供 UDP 数据报/字节数、最后来源与接收年龄、来源拒绝数、已解码消息数，便于区分网络未送达、来源不匹配和飞控心跳缺失；这些诊断计数不作为飞行数据。
- 展示 25 项姿态、航向、电池、高度、速度、GPS、振动、EKF 与负载数据；字段未上报、协议未知值、心跳或字段过期时显示“—”。没有独立空速传感器时，飞控上报的空速可能是估计值。
- 每个字段保留 MAVLink 消息来源和本机接收年龄。接收年龄不是端到端延迟，尚未与另一台电脑或飞控进行时钟同步；不能仅凭界面证明飞控采样至页面的绝对延迟。
- 请求完成 200 ms 后再次读取，无并发轮询；失败后 3 秒重试，页面隐藏时暂停。更新速度受 Mission Planner 实际转发频率影响。
- 不发送 MAVLink 指令、心跳、参数写入或解锁请求。人工起飞前检查项不自动打勾。

## Mission Planner 电脑设置

1. 确认 Mission Planner 已连接飞控：右上角按钮应显示“断开”，并有持续更新的真实遥测。若仍显示“连接”，先选择飞控对应串口并连接；HUD 上保留的旧数值不能证明连接仍有效。电池等未有效上报的字段继续保持为空。
2. 打开 MAVLink Mirror（某些版本在 Ctrl+F 工具窗口，另一些版本在 SETUP / Advanced）。
3. 选择 `UDP Client`，目标 IP `192.168.1.9`，目标端口 `14551`，不勾选 `Write`，点击连接。新版表格可选择 `UDP / Outbound`，Port 填 `14551`，Extra 填 `192.168.1.9`，Write 为 `False`。
4. 从该电脑访问 `http://192.168.1.9:3000/marp/uav-details.html`。不要使用 `127.0.0.1`，它指向该电脑自身。
5. 确认页面显示来源 `192.168.1.7`、SYS/COMP ID 和持续增加的消息计数；改变机体姿态并对照 Mission Planner 检验。转发停止后，心跳最迟 2 秒过期，单项数值按各自接收年龄清空。

若新建镜像行报“未将对象引用设置到对象的实例”，先确认该行所有字段填齐；在尚未启动的新行将 Write 勾选一次再取消，按 Tab 提交单元格后点击同一行 Go。本次迁移中此操作后用户确认 Started 且无报错。Started 仅表示镜像输出已创建，仍须由接收端实际 MAVLink 消息和飞控心跳验证链路。

镜像功能参考：[Mission Planner 源码](https://github.com/ArduPilot/MissionPlanner/blob/master/Controls/SerialOutputPass.cs)、[ArduPilot 文档](https://ardupilot.org/dev/docs/using-sitl-for-ardupilot-testing.html)。这里只使用其转发功能；生产接收器没有运行仿真或测试数据源。

## 本机启动与网络

首次安装：`python -m venv .venv-mavlink`，再执行 `.\.venv-mavlink\Scripts\python.exe -m pip install -r device\requirements-mission-planner.txt`。

- 接收器：`./start-mission-planner.ps1 -SourceIp 192.168.1.7`。
- 网页：`./start-connected.ps1`，默认监听 `0.0.0.0:3000`，可用 `-ListenAddress 127.0.0.1` 限制本机。`src/server.js` 直接启动时仍默认本机监听。
- 机载 IP 默认 `192.168.1.37`，`-UavHost`、车端参数和 `-DisconnectUav` 继续有效。
- 以管理员身份执行 `enable-mission-planner-network.ps1`，仅允许源 `192.168.1.7` 访问本机 `192.168.1.9` 的 UDP 14551 和 TCP 3000，不关闭防火墙。当前普通权限无法添加规则。

## 验证

`node --test`；`.\.venv-mavlink\Scripts\python.exe -m unittest discover -s device -p test_mission_planner_bridge.py -v`；配置 Playwright 后执行 `node dev/browser-flight-check.mjs`。

协议测试使用临时回环 UDP 端口，浏览器测试使用独立模拟服务；测试数据不发送到生产 14551 接收端。跨电脑真实链路必须在开启镜像并放行防火墙后实测。
