# 无人机只读遥测桥

## 横滚与俯仰（2026-10-08）

已在实机核验 `/mavros/imu/data` 和 `/mavros/local_position/pose` 均持续上报姿态四元数。沿用已有 pose 订阅，从飞控融合姿态换算 `telemetry.roll_deg` / `pitch_deg`，单位为度：MAVROS ENU/FLU 转换为航空 FRD 约定，横滚正值表示向右倾斜，俯仰正值表示抬头。四元数归一化后换算，非法四元数、超过 0.5 秒的样本或飞控断连返回 null；每项附带来源、单位、年龄与有效性。

独立 8768 桥已更新并重启；原飞控、测距与控制容器继续运行。备份为设备上的 `flight_status_http.before-attitude-20261008.py`。首次实机返回横滚约 -0.61°、俯仰约 -0.23°，接收年龄约 0.018 秒。Python 15 项测试覆盖方向、归一化、非法值、俯仰奇异点、过期和断连；尚未进行人工倾斜对照或实飞验证。

`flight_status_http.original.py` 是从代码包 Git 分支 `uavcar-uav-rpi-deploy` 的
`air_ground_landing/ros2_ws/src/air_ground_landing_ros2/air_ground_landing_ros2/flight_status_http.py`
读取的原件；`flight_status_http.py` 是本轮最小补充版本。本目录不修改上游仓库，不启动控制节点，不发送 MAVLink、ROS 控制指令或遥测速率请求。

## 真实来源与现有缺口

- 原桥已有 `/landing/sensor_range` 的下视测距。代码包的 `sensor_range_bridge.py` 从 MAVLink `DISTANCE_SENSOR`（消息 132、系统 200、组件 88、传感器 0、方向 25）读入，厘米转换为米；无效、超范围、重复/逆序及过期样本被拒绝。下游桥保留无效值为 `null`。
- 原桥已有 `/mavros/local_position/pose` 的 ENU `position.z`，名称为 `estimated_altitude_m`。这是局部坐标系估计高度，不能替代传感器下视测距，也不能直接标成相对 home 高度。
- 原桥没有电池电压、电池百分比和相对 home 高度的 HTTP 字段。代码包的 `pi_flight_recorder.py` 列出 `/mavros/battery` 与 `/mavros/global_position/rel_alt`，其作用是录制已有 ROS 数据，并未通过原 HTTP 桥暴露。
- 本版本增加 `sensor_msgs/BatteryState` 和 `std_msgs/Float64` 只读订阅。不保证飞控会发布；如果设备未配置电池监测、未上报电量估计、MAVROS 插件未开启或飞控断连，必须显示无有效数据。

ROS BatteryState 电压单位为 V，`percentage` 单位为 0 至 1 的比例，未测量为 NaN；桥只将上报比例乘以 100，不根据电压推算百分比。定义见 [ROS 2 BatteryState](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/BatteryState.msg)。相对高度来源为 MAVROS 的 `GLOBAL_POSITION_INT.relative_alt / 1000`，单位为米，见 [MAVROS global_position 插件](https://github.com/mavlink/mavros/blob/ros2/mavros/src/plugins/global_position.cpp)。

## HTTP 契约

接口仍为 `GET /api/status`，新增 `telemetry_contract_version: 2`。

`telemetry` 中的值为数值或 `null`：

- `battery_voltage_v`：`/mavros/battery.voltage`，V，只接受电池存在且有限的正值。
- `battery_remaining_pct`：`/mavros/battery.percentage × 100`，百分比 0 至 100；0 是有效数值，不将 NaN、负数、越界比例换成估算值。
- `relative_altitude_m`：`/mavros/global_position/rel_alt`，m，允许有限的负值；不回退至局部高度或下视测距。
- `rangefinder_m`、`estimated_altitude_m`：保留原接口和有效性门控。

`telemetry_meta` 为以上每个字段提供 `source`、`unit`、`age_s`、`max_age_s`、`age_basis`、`valid`、`reason`：

- `age_basis = bridge_receive_monotonic`：年龄是桥进程接收 ROS 消息后经过的时间，不能声称是硬件采样时间。这里不使用电脑与树莓派时钟差计算新鲜度。
- 电池和相对高度最多 3 秒；原测距与局部估计高度最多 1 秒。
- `reason`：`VALID`、`NO_SAMPLE`、`FLIGHT_CONTROLLER_DISCONNECTED`、`STALE`、`INVALID_OR_UNREPORTED`。
- `valid` 为 false 时对应 `telemetry` 值为 `null`。新鲜飞控状态且 `connected` 为 true 是所有上述值有效的前提。
- 新增顶层 `battery_age_s` 和 `relative_altitude_age_s`，保留 `vehicle_state_age_s` 与原字段。

`GET /api/history` 继续只提供内存历史；新增字段使用与 status 相同的过滤值。不得将内存历史当作持久化业务记录。

## 部署方式

推荐先独立启动只读桥，在 ROS 2 与 MAVROS 同一 ROS domain、相同网络/IPC 环境运行，使用另一个 HTTP 端口，避免重启包含控制执行器的原服务：

```bash
source /opt/ros/humble/setup.bash
python3 /path/to/flight_status_http.py --ros-args -r __node:=atomori_telemetry_http -p http_port:=8768 -p guided_status_topic:=/landing/action/status
```

原桥也可继续运行在 8766。确认新桥 `/api/status` 契约后，将控制台的无人机状态上游指向新端口。不要为了电池显示重启原控制栈、修改飞控参数或申请机器人控制权限。

验证设备侧应只读检查 `/mavros/state`、`/mavros/battery`、`/mavros/global_position/rel_alt`、`/landing/sensor_range` 的类型和实时发布情况。未收到有效消息应显示缺失，不把测试样本、历史值或图传正常当成飞控正常。

## 本地验证

```powershell
python -m unittest discover -s device -p 'test_*.py' -v
python -m py_compile device/flight_status_http.py
```

测试使用标准库和 ROS import stub，不启动 ROS 节点、不连接设备、不写控制：覆盖空状态、单位/比例、未知和越界值、有效的零电量、未安装电池、过期/恢复、飞控断连、飞控状态过期、三类高度保持独立和历史有效性过滤。设备侧真实数据发布与部署效果须另行现场验证。

## 历史现场只读检查（2026-10-08 13:31，UTC+8）

- `192.168.1.69:8766/api/status` 现已报告飞控连接、STABILIZE、未解锁；与此前 DISCONNECTED 检查属于不同时间快照。
- 本机 API 连续五次读取均为在线状态，状态年龄约 0.44–0.98 秒。下视测距由原桥提供约 0.07–0.08 m，已在实际浏览器前端显示；接收时间每次更新，页面按轮询刷新。
- 电压、电量和相对 home 高度仍为 null。局部 ENU 高度有上报，但不作为相对 home 高度的替代；当前还不能宣称四项均有实机实时数据。
- 用户提供的 SSH 密钥路径属于 `C:\Users\zc325`，该账户目录及密钥文件在当前电脑不存在；当前账户 `.ssh` 只有 known_hosts，SSH agent 不可用。按所给命令尝试登录仍被拒绝，新增采集桥未部署。需要本机可用密钥的实际路径，不能用截图中的路径文字代替密钥文件。

## 已完成现场部署（2026-10-08 13:50，UTC+8）

用户提供本机实际密钥文件后，SSH 已登录 `pi@192.168.1.69`（uavpi）。密钥未写入项目或输出其内容。原机载服务运行在用户级 Podman 容器中；8767 已被 lidar_observer 占用，所以使用 **8768**。

- 新建 `/home/pi/atomori_console_telemetry`，上传本目录的 `flight_status_http.py`、`atomori-telemetry.service` 和只读诊断 `probe_topics.py`。
- 新建并启用用户级 `atomori-telemetry.service`，使用设备已有 ROS Humble 镜像、host network/IPC、只读文件系统与代码挂载、tmpfs 日志；没有绑定串口设备。
- 源文件本机与设备 SHA256 一致。服务已实际启动并完成独立重启恢复；启动前仅清理同名 `atomori-telemetry` 容器，修复 rootless Podman 残留容器导致的重启名称冲突，不清理其他容器。
- 当前执行器真实状态话题是 `/landing/action/status`，通过 `guided_status_topic` 参数订阅；验证 v2 / IDLE 状态保留。
- 原 MAVROS、视觉、range bridge、landing executor 服务未重启，未设置飞控参数、未请求遥测速率、未发送控制指令。启用服务不等于已执行整机重启验证。
- 本机 `start-connected.ps1` 已指向 `http://192.168.1.69:8768`。查询该桥后，后端与浏览器已显示真实相对 home 高度及下视测距。

最新连续四次本机 API 采样：相对 home 高度 3.559 / 3.638 / 3.762 / 3.762 m，接收年龄 0.007–0.102 s；下视测距 0.08 / 0.08 / 0.09 / 0.08 m，接收年龄 0.007–0.044 s。这些是当时实机快照，不是固定值、飞行验证或校准精度证明；相对 home 高度不能当作对地距离。

### 电池剩余缺口

只读订阅实际收到 `/mavros/battery`：`present=true`、`voltage=0.0`、`percentage≈-0.01`、无单节电压。百分比为未知值，不代表负电量；0 V 不能当作有效电池测量。桥与页面继续返回 null / —。

通过 `/mavros/param/get_parameters` **只读查询缓存**，`BATT_MONITOR=0`、`BATT2_MONITOR=0`；电压/电流引脚参数未在缓存中提供。官方定义 0 为关闭，见 [ArduPilot 电池监测配置](https://ardupilot.org/copter/docs/common-power-module-configuration-in-mission-planner.html)。未调用 set/pull 参数服务。

电池显示还需要确认实际飞控、电源监测模块型号及 POWER 接线，按真实硬件配置并校准后才可验证。不能盲目设为某一种监测类型，也不能把电压推算的百分比替代飞控有效上报。

服务只读检查：`systemctl --user status atomori-telemetry.service`，接口 `GET http://192.168.1.69:8768/api/status`。重跑诊断可使用 `podman exec atomori-telemetry /bin/bash -lc 'source /opt/ros/humble/setup.bash && python3 /telemetry/probe_topics.py'`；它只读 ROS 样本与参数缓存，不发布控制或改参数。


## 地面高度显示纠正（2026-10-08 14:09，UTC+8）

- 实机飞控报告 ON_GROUND、STABILIZE、未解锁，下视传感器距离约 0.07–0.08 m；同一时段 home 高度估计从 4.34 m 漂到 5.543 m。原上报值真实存在，但不能证明无人机离地 4–5 m；此前只验证来源与新鲜度，未验证高度基准。
- 主卡改为“离地高度”，新鲜 ON_GROUND 显示“地面 / 未标定”；其他有效状态显示“— / 未标定”，离线显示“—”。“设备详情”保留明确标注的原始 home 估计与传感器距离；不减去固定偏差、不强制归零、不将测距斜距冒充机体离地高度。
- API 保留 relativeAltitudeM 原值，并标记 kind=estimate、reference=home、referenceVerified=false；新增 heightAboveGroundM=null、heightAboveGroundStatus=NOT_CALIBRATED。landedState 只有飞控连接且 state/extended_state 年龄均不超过 2 秒时有效，否则 UNKNOWN。
- 只读 ROS 诊断读到 GPS fix=-1、缓存 EK3_SRC1_POSZ=1、AHRS_EKF_TYPE=3。官方将 POSZ=1 定义为气压计，见 [EKF 高度来源](https://github.com/ArduPilot/ardupilot_wiki/blob/master/common/source/docs/common-ekf-sources.rst)；[home 相对高度与 AGL 定义](https://ardupilot.org/copter/docs/common-understanding-altitude.html)不同。当前表现与高度估计/基准漂移相符，这是诊断推断，尚未完成传感器精度或飞控基准校准。
- 本轮 Node node --test **19/19 通过**；Edge 浏览器回归 **17 组检查通过**，使用独立临时记录与模拟上游。新增验证地面 home=4.25 m 不显示成离地高度、原估计保留、落地状态过期失效、飞行状态不伪造零高度；已有业务与只读图传回归通过。
- 已重启本机后端并在当前真实浏览器点击下视验证“地面 / 未标定”与约 0.07 m 测距，设备控制仍禁用。真实离地高度数值的校准、已知高度对照和实飞验证：**未验证**。需实测安装基准偏移、验证传感器方向/姿态和有效量程后接入校准值；本轮没有改飞控参数、重启原控制栈或发送设备控制。
