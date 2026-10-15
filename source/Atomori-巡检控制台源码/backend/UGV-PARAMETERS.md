# 无人车代码逻辑与前端参数同步

2026-10-14，依据用户提供的本地代码完成分析与接入。参考源码仅被读取，没有修改或部署到树莓派。

参考源码包：用户提供的 2026-10 文件目录中的 `UAV-CAR-main (1)(1)/UAV-CAR-main`。

## 数据与控制链路

R680 是阿克曼转向底盘，前轮转向、后轮驱动，不能横移或原地自旋。`CAR/CAR_ws/src/car_nodes/car_nodes/motor_driver.py` 与 `wheeltec_protocol.py` 处理 STM32 串口帧，发布 `/motor_feedback` 与板载 IMU；`chassis_controller.py` 结合反馈形成里程计。激光雷达、GPS、超声、相机和推杆由各自节点发布。

`car_sim/web_gateway.py` 订阅 `/odom`、`/scan`、`/fix`、`/ultrasonic/range`、`/map`、`/amcl_pose`、三路相机、`/leadscrew/status` 以及混合器/指令网关状态，输出 HTTP 只读快照、图像和雷达点。部署快照的地址是 `192.168.1.21:8765`。`car_sim/leadscrew_web.py` 另订阅 `/leadscrew/detail`，提供机构详情。

设备的控制链路是导航/遥控 → `ugv_control_mux` → `ugv_command_gateway` → 底盘。混合器处理急停、任务门控、操作端心跳、导航/遥控优先级和巡航转向辅助；网关进行限幅和指令超时停车。前端显示这些状态及输出指令值，不能把输出指令误称为实测速度。本次新增适配只调用 GET，`commandsEnabled=false`，没有开放车辆移动、导航目标、建图启停、推杆动作或复位按钮。

环境传感器由 `CAR/deployment/home/ubuntu/dht_service.py` 独立采样，温湿度约每 3 秒尝试，数字输入约每 20 ms 读取、150 ms 去抖，缓存约每 250 ms 更新。倾斜、火焰、MQ2 的 BCM GPIO 分别为 13、6、18，触发极性由配置决定。HTTP 快照按缓存时间计算年龄并标注可用/过期；前端继续独立检查有效性。

## 参数对照

主页面的四格车辆指标、三个数字报警、地图画面区、底部位置栏和原有详情弹窗位置保留。新增详细参数使用弹窗内的折叠分组；原二维/2.5D 管廊图与演示任务布局不变。

| 来源 | 参数 | 展示位置与处理 |
| --- | --- | --- |
| `/api/status.gateway` | ok、service、schema_version、uptime_s、camera_backend | 车辆与环境：服务、健康、版本、运行时长、相机后端 |
| `server_time_ms` | 车端查询快照时间 | 车辆遥测时间、详情；不是传感器采样时间 |
| `odom` + `topic_ages_s.odom` | pose=[x,y,yaw]、speed_mps | 主速度、底部里程计位姿、定位详情；速度是模长，航向 rad 转 ° |
| `environment` | temperature_c、humidity_percent、age_s、available、stale、error、consecutive_errors | 主温湿度、环境详情、错误信息；零值有效 |
| `environment.digital.{tilt,flame,mq2}` | triggered、level、raw_level、gpio、active_level、changes、age_s、available、stale | 主报警和数字采样表；原始电平与触发状态分开 |
| `environment` | updated_at、last_attempt_at、sampled_at | 完整原始参数折叠区，保留设备 Unix 时间，不用于跨机器年龄判断 |
| `ultrasonic` | range、age_s | 详情后向超声距离，m |
| `gps` | status、latitude、longitude、altitude、age_s | GPS 状态、经纬度、高度；无定位时不显示坐标 |
| `localization` | active、state、backend、map_name、since_s、map_pose、age_s、confidence、xy_sigma_m、yaw_sigma_rad、error | 定位详情；新鲜且已定位时沿用底部地图位姿，否则回退新鲜里程计 |
| `ugv_control_mux` | authority、reason、enabled、require_mission_status、emergency_stop、gate_open、mission_active、mission_paused、mission_state、mission_gate、operator_requested | 控制链路详情；任一新鲜急停源触发时主车辆状态显示急停 |
| `ugv_control_mux.ages_s` | navigation、teleop、mission_status、mission_gate、operator | 各输入数据年龄 |
| 混合器/指令网关 | output_linear_mps、output_angular_rps | 指令输出，单位 m/s、rad/s；不代替实测速度 |
| `ugv_command_gateway` | enabled、emergency_stop、reason、input_age_s、command_timeout_s | 网关状态、输入年龄和超时阈值 |
| `avoidance` | available、cruise_enabled | 避障巡航查询快照 |
| `map` | width、height、resolution、origin、age_s | 栅格元数据，区分历史地图内容和实时查询 |
| `mapping` | active、since_s、initial_pose、current_pose | 建图状态、时长、TF 查询位姿；TF 年龄未提供，不声称已核验新鲜度 |
| `leadscrew` | state[2]、pos_mm[2]、enabled[2]、age_s、closed | 双组状态、相对位置与使能；closed 原值仅保留在原始诊断，不用作落位确认 |
| `camera`、`camera_rear` | ready、age_s | 相机状态与前后视画面 |
| `/api/camera_top.jpg` | 俯视 JPEG | 详情“查看俯视”复用原画面区；该版本 status 未输出俯视 ready/age，不编造帧龄 |
| `topic_ages_s` | 所有已上报话题年龄 | ROS 数据新鲜度表 |
| `/api/nav/status` | active、has_map、goal、path | 导航状态、目标与全部有效路径点，只查看，不设置目标 |
| `/api/auto_cruise/status` | active、initial、map_name、map_info | 巡航快照、起点和导航地图元数据 |
| `/api/maps` | maps 列表 | 查看已保存地图按钮，严格限制安全文件名；选图仅获取 PNG，不调用 load_map |
| `/api/leadscrew/manual/status` | available、simulated、busy、moving、resetting、message、output、state、pos_mm、enabled、speed | 详细机构状态、模式、软件反馈、脉冲频率 |
| 机构详情 | position_reference、alarm_feedback、simulation_clamped、simulation_next_action | 明确位置是启动后相对脉冲估算，软件归中标记不等于物理落位 |
| 机构详情 | simulation_geometry、pins | 开口/行程/圈数/脉冲数以及各组 STEP/DIR/EN 引脚配置 |
| `/api/scan.json` | age_s、range_max、points、escape_path | 雷达点、范围、年龄和脱困折线；源码 `_publish_escape_path` 明确 x 前/y 左的车体坐标 |
| 以上所有 JSON | 完整原始快照 | “原始只读参数”折叠区；明确为未经过滤的最后一次快照，过期数据不得作为实时值 |

## 真实性与未接入项

- 电池：网关 `battery_voltage` 当前明确固定为 `None`，没有电量百分比。底盘 ROS `/motor_feedback` 有电压、后轮速度和转向角，但 HTTP 网关未订阅它们；驱动还会重复发布串口旧缓存，且仿真有假电压。因此不从静态源码常量或缓存猜测实车电池/轮速/转向角。
- IMU：ROS 驱动可发布加速度/角速度，但 HTTP 网关尚未暴露。原始 IMU 的 orientation 不可用，不能据此编造小车姿态角。
- 推杆：`leadscrew_motion.py` 计数已发送脉冲，位置以节点启动为相对基准，`alarm_feedback=False`。名称含 simulation 的顺序归中动作也可能驱动真实 GPIO，实际模式取决于 `simulated`。本次只显示状态，不调用动作接口。
- 落位/充电：`landing_receiver.py` 收到 UDP 文本或事件后锁存并触发机构顺序运动；“充电完成”文本不是实际电流、电压或接触传感器。没有电气测量时保留“落位/充电电气未接入”，不显示充电成功。
- 气体：MQ2 只有数字报警，不能推算 O₂、CO、H₂S、ppm 或 %LEL；环境温度也不能替代红外最高温度。
- 相机 FPS、分辨率及延迟：代码配置的采集频率/尺寸不是运行实测值；没有采样时间戳时不声明端到端延迟或帧率。
- 主态势图：车端地图与原管廊示意图未配准，不把真实车端坐标直接投到原示意图中。

## 新增本机接口与刷新

`GET /api/v1/devices/UGV-01/details` 并发读取导航、自动巡航、地图列表、机构详情，按 section 返回 `available/data/error/ageS/maxAgeS`。单项 404、超时或无效 JSON 仅使该项不可用，不阻塞独立基础遥测。该路由没有 POST 转发能力。

基础遥测每次完成后约 1 秒再次查询；详情每次完成后约 3 秒再次查询；图像和地图沿用原刷新机制。详情快照最长展示 6 秒，明确为查询状态而非传感器采样。速度/数字信号/超声/机构/定位样本最多 2 秒，GPS 最多 3 秒，温湿度最多 10 秒。后端计入上游请求耗时，浏览器每 250 ms 累计本机接收后的年龄；请求挂起时旧值仍会失效。雷达画布也在过期后清空。

历史地图可以保留缓存，但明确标记缓存名称。当前或其他已保存地图通过详情预览，选中地图与返回请求匹配后才替换图片；分辨率只使用匹配地图的已上报元数据。选图失败时仍标明实际显示的旧缓存地图。

## 验证与部署

后端契约验证：`node --test`。新增 `test/ugv-details.test.js` 覆盖完整参数、零值、请求年龄、地图文件名、详情故障隔离、并发与 GET 边界；原业务记录、UAV 和媒体测试继续保留。

浏览器验证：`node dev/check-ugv-live.mjs`、`node dev/check-ugv-parameters.mjs`、`node dev/browser-records-check.mjs`，使用独立临时记录和本机 HTTP 夹具，不连接设备。参数脚本截图输出至仓库 `output/playwright/`，截图使用模拟数据，不能当实机在线证明。

本次结果：后端 **33/33 通过**，上述三套 Edge/Playwright 浏览器回归均通过；覆盖缺失/过期清空、恢复、零值、单项接口失败、原布局、相机/地图预览、文本安全、业务记录和控制关闭。`node --check` 与 `git diff --check` 通过。

已重启此前由本对话启动的本机 3000 只读后端，并在实际浏览器刷新、打开车辆详情核验新版分组。新 `/details` 路由返回 HTTP 200，当前四个上游 section 均为 `UPSTREAM_UNAVAILABLE`；机载视觉/飞控配置仍为 false，设备指令仍关闭。实际离线页面截图为 `output/playwright/ugv-parameters-current.png`。

目前电脑的已知网络是 `10.8.40.10`，历史配置车端 `192.168.1.21:8765` 连接超时。接口与前端已可接收上述真实返回字段，但此次无法完成实车在线核验。无人机按用户要求继续断开，参考树莓派源码没有被改动或部署。
