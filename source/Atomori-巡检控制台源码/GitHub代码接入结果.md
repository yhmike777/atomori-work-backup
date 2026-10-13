# UAV-CAR 代码接入结果

## 最新车端实时同步（2026-10-09）

已连接用户确认的 `192.168.1.21:8765`。启动脚本加入车端地址；后端适配实机温湿度、倾斜/火焰/MQ2 开关量、超声和话题年龄；前端每秒独立刷新并累计缓存年龄，补齐实时车辆详情、二维雷达、地图与前后视入口。数字开关量不作为气体浓度，电量不估算，缺失/过期/断连清空。

实机只读检查通过：三次状态时间更新，车速 0.00 m/s、当次有效温湿度约 24.2 °C / 55 %RH，倾斜触发、火焰/MQ2 未触发，雷达与地图返回成功。相机暂无帧、电量/GPS/超声缺失；AMCL 过期时显示里程计，未映射到示意地图。机载地址当时不可达，小车刷新不受影响。23/23 后端测试、小车浏览器夹具、原19组浏览器回归通过；没有发送设备控制或改变设备服务。以下车端尚未验证及无环境 API 的描述属于历史状态，当前接入以此节及 backend/README.md 为准。

代码接入历史核对日期：2026-10-07。审阅的提交：`main` `f6646e1`、`car-rpi-deploy` `92f9b4a`、`uav-rpi-deploy` `793630d`、`uav-pixhawk-deploy` `53b53a9`。当时已完成代码契约测试，并检查机载树莓派的**只读 HTTP 服务**；车端和设备控制未现场验证。

2026-10-08 完成页面业务记录 API 接入、图传 8 秒断开修复及真实遥测只读桥部署。真实 OV9281 已验证连续 90 秒图传，前端下视测距实时显示；home 高度仅为基准未核验的飞控估计，主卡离地高度显示“地面 / 未标定”；电池监测关闭，尚无有效电压和电量值。下面 2026-10-07 结果为历史记录。

## 最新机载只读连接检查（2026-10-08，业务接入验证之后）

- 重新检查 `192.168.1.69:8765/api/status` 与 `:8766/api/status`，均返回 HTTP 200；视觉服务报告 OV9281 / apriltag。
- 当前后端已通过 `backend/start-connected.ps1` 启动，机载视觉和飞行状态已配置，模式为 `upstream-readonly`，控制仍关闭。
- 在当前控制台实际刷新并点击“下视”，浏览器从同源 `/api/v1/devices/UAV-01/cameras/ov9281.mjpg` 解出 640×400 画面；上游 `/stream.mjpg` 返回 MJPEG 流。
- 本次只验证网络只读服务和下视出图；飞控服务当前报告 `DISCONNECTED` / 未连接，未验证飞行、移动、云台或补能。不能据图传成功宣称整机控制接入成功。

## 已接入：配置地址后可使用的只读接口

- **车端状态**：车端 [`web_gateway.py`](https://github.com/SmallH0433/UAV-CAR/blob/car-rpi-deploy/src/car_sim/car_sim/web_gateway.py) 的 `GET /api/status` 映射至本服务 `GET /api/v1/devices/UGV-01/telemetry`。包括里程计位姿/速度、GPS、相机就绪与数据年龄、定位/建图、推杆机构、控制权 mux、命令网关状态。页面显示车速；电量百分比、温湿度和气体没有对应字段，显示 `—`。
- **车端图像**：车端 `GET /api/camera.jpg`、`/api/camera_rear.jpg`、`/api/camera_top.jpg` 经同源代理暴露；页面使用前视画面，后视和顶视已有 API，尚未增加页面入口。没有新帧时上游返回 503。
- **车端雷达/地图**：车端 `GET /api/scan.json` 和 `/api/map.png` 已接入 API；页面新增“车端地图”按钮查看实际地图图像。原管廊 2.5D 示意图、路径和车辆标记仍为样本，未做地图坐标配准。
- **无人机视觉与飞行状态**：机载 [`ov9281_unified_service.py`](https://github.com/SmallH0433/UAV-CAR/blob/uav-rpi-deploy/ov9281_debug/ov9281_unified_service.py) 的 `GET /api/status` 提供视觉状态；[`flight_status_http.py`](https://github.com/SmallH0433/UAV-CAR/blob/uav-rpi-deploy/air_ground_landing/ros2_ws/src/air_ground_landing_ros2/air_ground_landing_ros2/flight_status_http.py) 在 `8766` 提供飞控状态。两者映射至 `GET /api/v1/devices/UAV-01/telemetry`，页面显示飞控模式、解锁状态、电池电量/电压和下视测距，离地高度未标定，home 估计仅诊断展示，依据上游有效性与年龄判断过期；原局部估计高度仅保留在 API，不替代相对 home 高度。直接飞行接口临时不可用时回退至视觉服务内嵌快照。
- **无人机图传**：OV9281 `GET /stream.mjpg` 已接入页面“下视”标签；车端 [`uav_camera_proxy.py`](https://github.com/SmallH0433/UAV-CAR/blob/car-rpi-deploy/src/car_sim/car_sim/uav_camera_proxy.py) 提供 `/api/uav/stream` 的 A8 转发，已接入页面“可见光”标签。A8 的独立 `:8870` 服务不在给出的机载部署分支中，能否出图需现场确认。

以上接口通过 `ATOMORI_CAR_URL`、`ATOMORI_UAV_VISION_URL`、`ATOMORI_UAV_FLIGHT_URL` 分别配置。历史机载地址已写入 `backend/start-connected.ps1`，当前是否可达需重新核验；未配置时页面展示设备样本和本机业务记录。已配置时只读数据与视频通过同源后端访问，任务仍为演示，本机记录可保存，设备控制按钮禁用。Pixhawk 部署分支仅有[固件和参数](https://github.com/SmallH0433/UAV-CAR/tree/uav-pixhawk-deploy)，没有可直接代理的 HTTP API；飞控状态来自机载 MAVROS 状态桥。

## 本轮已接入：本机业务记录（2026-10-08）

- 页面初始化读取演示任务、设施目录和服务端疑点/复查/事件，统一显示加载中、空数据和失败。任务 ID 集中来自任务 API；目录缺失点位禁止随意绑定其他设施。
- 标记疑点保存人工 `assetId/source/note`，后端成功后才关闭弹窗；提交期间禁用重复点击，失败保留备注并可重试。POST 可选持久化 `requestId`，同键同内容返回原记录 `200`，首次 `201`，异内容 `409`。
- 知悉、人工复核按 `finding.id` 操作，`pending/acknowledged/reviewed` 映射中文状态；PATCH 携带 `expectedStatus` 防止过时页面覆盖，已复核不能退回。
- 加入复查按 `assetId` 去重，取消按 `recheck.id` 操作，之后刷新服务端队列。加入复查只是保存业务记录，不下发机器人任务。
- 查看事件以服务端记录为准，显示相关疑点/复查 ID；本地设备操作演示单独分区，并明确不是设备回执。导出从后端 GET export 获取记录，文件名为 `Atomori-本机业务记录.json`。
- 使用本机 `backend/data/records.json`，落盘完成后才发布快照；没有用浏览器数组或 localStorage 替代存储。`api.js` 集中调用，`records.js` 管理业务数据，`live.js` 保留只读遥测/图传职责。
- 气体采样保存禁用，仪表/声学只允许人工观察备注；样本读数、频谱和图片不写成真实测量或实机证据。启动与点击步骤见 [backend/README.md](backend/README.md)。

## 还没有接入的清单

- **车端现场验证**：尚无当前车端地址。`192.168.1.21:8765` 是代码文档中的历史候选，在本机探测超时。车端接口仅用模拟 HTTP 上游验证，不能确认实际车、传感器和视频状态。
- **无人机电量/电压**：`backend/device/flight_status_http.py` 的真实订阅已部署；实机原始上报 0 V、未知百分比，参数缓存电池监测为关闭，需确认电源模块和接线后配置、校准。相对 home 高度与下视测距已在前端实机实时验证。姿态角、链路时延仍未接入。
- **小车电量百分比、环境温湿度、O₂、CO、H₂S**：车端状态的 `battery_voltage` 仍为 `null` 占位；其他传感器没有页面所需 API。需设备节点和数据发布。
- **真实任务队列、12 点位进度、巡检阶段、事件回执**：四个分支没有与该页面任务编号匹配的任务调度/事件接口。页面这些区域仍为演示状态。
- **真实设施目录与空间模型**：现有骨架仅 7 个样本设施，页面写 38 处；车端占据栅格地图与页面 2.5D 管廊图没有统一坐标系/设施 ID，不能直接叠加。
- **空地相对位姿**：OV9281 提供 AprilTag 观测，但页面的 Δx/Δy/高度/航向是着陆平台相对位姿。须确认 Tag 语义、相机外参、BODY_FRD 到页面坐标的变换和时间同步，当前显示 `—`。
- **热像、气体、仪表核读、声学、缺陷识别及历史趋势**：提供的部署分支没有这些业务测量数据的统一 HTTP 接口；页面六类业务工作台仍使用本地样本。
- **补能平台电气状态**：车端可提供推杆机构状态，但不提供落位接触、充电电压/电流/温度和联锁全链条；页面 DOCK-01 仍为演示。
- **生产身份、证据和测量模型**：页面操作记录与本机后端同步已完成；账号权限、操作者身份、可信证据引用和专门测量字段仍未接入，不能把本机记录视为生产任务或实测报告。
- **真实控制**：车端代码虽有遥控、导航、建图、推杆和云台转发接口，机载动作由 RC 和执行器状态机管理；当前后端 `POST /api/v1/commands` 保持 503。页面控制按钮在只读模式被禁用。接入前需明确网页按钮与真实指令的一一对应、控制权、鉴权、设备确认、超时及联锁，实机测试再开放。

## 本轮验证（2026-10-08）

- `node --test`：**18/18 通过**，含原业务/适配器回归、6 项媒体长流/取消/有限响应超时、3 项遥测来源与有效性测试。Python 设备桥单元测试 **12/12 通过**，使用 ROS stub，不代表实机消息发布。
- 实际启动 `src/server.js` 后端子进程，停止后重新启动两轮，确认业务记录、状态、队列和幂等键跨进程保存；既有模拟车端/机载只读代理与真实控制 `503` 回归通过。
- 本轮浏览器实际点击验证：Edge 无头浏览器 + Playwright 实际点击验证 **16 组检查通过**：加载/空列表、保存与刷新/重启、知悉/复核、复查加入/取消与重复提示、真实后端停机及8秒超时后备注保留、分资源加载失败、丢失响应幂等重试、状态冲突同步、安全文本、目录缺失拒绝、服务端导出一致、样本保存边界与来源正确性、只读遥测/图传与控制禁用；无页面脚本错误。使用独立临时 JSON 与模拟上游，没有改动默认记录文件。
- 实机只读 OV9281 图传：代理连续 90.12 秒 / 761 帧 / 18,785,249 字节，浏览器 640×400 且持续接收、无脚本错误。ROS 2 构建、新增遥测桥部署、飞控/电池/测距/相对高度真实数值、真实飞行、车端移动、云台和补能：**未验证**。SSH 返回 `Permission denied (publickey,password)`；未解除控制禁用。

图传根因是旧 8 秒 AbortSignal 也取消响应体，实测断在 8.013 秒；已改为连接超时与流生命周期分开，增加接收统计与页面断线重连。相对高度改用 `relative_altitude_m`，不混用原局部 ENU `estimated_altitude_m`；电量不从电压推算，测距不从视觉距离替代。启动、验收和设备桥独立部署步骤见 [backend/README.md](backend/README.md) 与 [device/README.md](backend/device/README.md)。

2026-10-08 13:31（UTC+8）再次真实只读检查：飞控已在线，STABILIZE、未解锁；连续五次 API 的接收时间更新、状态年龄 0.44–0.98 秒，下视测距约 0.07–0.08 m 已在当前前端显示。电池电压、电量与相对 home 高度仍未上报。截图中的密钥路径对应本机不存在的用户目录；按该路径 SSH 登录仍失败，新增采集桥未部署。之前 DISCONNECTED 为历史时间快照。

2026-10-08 13:50（UTC+8）后续完成：已 SSH 登录 uavpi，独立启用只读 Podman 服务 `atomori-telemetry.service`（8768，原 8767 为 lidar_observer）。前端测距与相对 home 高度实际显示，四次连续 API 验证数据更新、年龄有效；执行器 v2 / IDLE 保留，原 MAVROS/landing/range 容器未重启，控制仍 503。电池话题已读到但 0 V / 未知电量；只读参数缓存 BATT_MONITOR、BATT2_MONITOR 均为 0。没有更改飞控参数。Node 18/18、Python 12/12 再次通过；电池有效数值、校准精度、整机重启及真实飞行仍未验证。

## 历史验证记录（2026-10-07）

- `node --test`：2 项通过。使用本地模拟车端与机载服务验证状态字段映射、相机/地图/雷达代理、缺失字段保持 `null`，并验证控制仍返回 503。
- `node --check`：后端及页面 JavaScript 语法检查通过。
- 本地浏览器检查：使用 `dev/live-fixture.js` 的模拟上游，验证只读状态显示、缺失值、设备切换后控制禁用、设备详情弹窗及下视图传离线提示；页面无脚本错误。
- 机载现场只读检查：`192.168.1.69:8765/api/status`、`/api/flight-status` 和 `192.168.1.69:8766/api/status` 均返回 HTTP 200；服务识别为 OV9281，飞行状态报告飞控在线。经本地后端代理后，页面读取到飞行状态；浏览器从 `/api/v1/devices/UAV-01/cameras/ov9281.mjpg` 解出 640×400 帧。当前模式等遥测值会变化，不应当作持久状态。
- 未执行 ROS 2 构建、真实飞行、车端或现场控制测试。


## 地面高度显示纠正（2026-10-08 14:09，UTC+8）

- 实机飞控报告 ON_GROUND、STABILIZE、未解锁，下视传感器距离约 0.07–0.08 m；同一时段 home 高度估计从 4.34 m 漂到 5.543 m。原上报值真实存在，但不能证明无人机离地 4–5 m；此前只验证来源与新鲜度，未验证高度基准。
- 主卡改为“离地高度”，新鲜 ON_GROUND 显示“地面 / 未标定”；其他有效状态显示“— / 未标定”，离线显示“—”。“设备详情”保留明确标注的原始 home 估计与传感器距离；不减去固定偏差、不强制归零、不将测距斜距冒充机体离地高度。
- API 保留 relativeAltitudeM 原值，并标记 kind=estimate、reference=home、referenceVerified=false；新增 heightAboveGroundM=null、heightAboveGroundStatus=NOT_CALIBRATED。landedState 只有飞控连接且 state/extended_state 年龄均不超过 2 秒时有效，否则 UNKNOWN。
- 只读 ROS 诊断读到 GPS fix=-1、缓存 EK3_SRC1_POSZ=1、AHRS_EKF_TYPE=3。官方将 POSZ=1 定义为气压计，见 [EKF 高度来源](https://github.com/ArduPilot/ardupilot_wiki/blob/master/common/source/docs/common-ekf-sources.rst)；[home 相对高度与 AGL 定义](https://ardupilot.org/copter/docs/common-understanding-altitude.html)不同。当前表现与高度估计/基准漂移相符，这是诊断推断，尚未完成传感器精度或飞控基准校准。
- 本轮 Node node --test **19/19 通过**；Edge 浏览器回归 **17 组检查通过**，使用独立临时记录与模拟上游。新增验证地面 home=4.25 m 不显示成离地高度、原估计保留、落地状态过期失效、飞行状态不伪造零高度；已有业务与只读图传回归通过。
- 已重启本机后端并在当前真实浏览器点击下视验证“地面 / 未标定”与约 0.07 m 测距，设备控制仍禁用。真实离地高度数值的校准、已知高度对照和实飞验证：**未验证**。需实测安装基准偏移、验证传感器方向/姿态和有效量程后接入校准值；本轮没有改飞控参数、重启原控制栈或发送设备控制。
