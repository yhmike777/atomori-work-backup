# UAV-01 Mission Planner 实时遥测

控制台 UAV-01 旁的「飞控详情 ↗」进入 `/marp/uav-details.html`。页面保留飞行仪表、状态、健康检查和数据，不包含地图。

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

1. 确认 Mission Planner 已连接飞控，姿态、电池随实际设备变化。
2. 打开 MAVLink Mirror（某些版本在 Ctrl+F 工具窗口，另一些版本在 SETUP / Advanced）。
3. 选择 `UDP Client`，目标 IP `192.168.1.9`，目标端口 `14551`，不勾选 `Write`，点击连接。新版表格可选择 `UDP / Outbound`，Port 填 `14551`，Extra 填 `192.168.1.9`，Write 为 `False`。
4. 从该电脑访问 `http://192.168.1.9:3000/marp/uav-details.html`。不要使用 `127.0.0.1`，它指向该电脑自身。
5. 确认页面显示来源 `192.168.1.7`、SYS/COMP ID 和持续增加的消息计数；改变机体姿态并对照 Mission Planner 检验。转发停止后，心跳最迟 2 秒过期，单项数值按各自接收年龄清空。

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
