# A2 mini 相机摇杆

本目录保存车端相机区域的 HTML、CSS 和控制器；巡检平台的 `marp/ugv-control.html` 通过 iframe 打开车端页面。

## 修改与验证

- `a2-camera.html`：相机画面、拍照和竖向摇杆布局。
- `a2-joystick.css`：桌面左右布局，640px 以下上下布局。
- `a2-joystick.js`：沿用 `/api/a2/gimbal` 的 `press_id`、速度 20 和 150ms 续期；反向先停止，松手、失焦、明确离线及退出时停止，但保留滑块位置。停止连续失败会锁定摇杆，点击“停止云台”确认成功后恢复。
- `test-a2-joystick.mjs`：VM 内模拟 DOM、网络、计时器，不访问设备。
- `update-page.py`：对下载的按钮版或摇杆版页面仅替换三个相机区域；锚点不匹配时拒绝生成，避免覆盖不同版本。
- `remove-uav-camera.py`：按用户要求从车端页面删除无人机云台摄像头卡片、样式和独立脚本，保留小车相机和窄屏网格布局。

验证命令：`node --test vehicle-ui/test-a2-joystick.mjs`。

生成命令：`python vehicle-ui/update-page.py <车端最新页面副本> <新页面输出路径>`。部署前重新比较远端与下载基线，不能拿旧页面覆盖车端其他功能。

## 2026-10-27 部署记录

- 设备：`ubuntu@192.168.1.21`，HTTP 端口 `8765`。
- 生效源码：`/home/ubuntu/CAR_ws/src/car_sim/car_sim/web/index.html`。
- 安装目录中的 HTML 是该源码的符号链接，网关每次请求读取文件，无需重启 ROS 或车辆控制服务。
- 车端备份：`/home/ubuntu/CAR_ws/camera_ui_backups/index.before-a2-joystick-20261027.html`。
- 本机基线和部署副本：`D:\page change\.codex-backups\20261027-a2-joystick`。
- 上传前验证车端基线未变化，校验上传内容后原子替换；HTTP 返回内容与新页面逐字节一致。
- 已通过 12 项隔离测试、全部 5 个内联脚本语法检查，以及桌面和窄屏布局检查。除相机控制器外，其余内联脚本未改动。
- 实机仅核验页面、视频和云台连接状态，没有进行云台转动或车辆行驶测试。

回退前先检查是否有后续更新，再用上述备份恢复该 HTML；不要覆盖后续车端改动。SSH 凭据不写入项目。

## 同日更新：拖动位置保留

- 用户确认“保留位置，松手停转”。抓住滑块本身不发运动指令；移动至少 2px 后按实际拖动方向转动，松手保留位移和行程标记。再次抓取不跳动，在上半区向下拖也会向下转。
- 没有固定按住时长上限。实测状态 GET 曾耗时 3.2 秒，旧界面会在 2 秒状态查询超时后结束拖动。现仅状态读取异常不会中断正在续发的控制；控制请求失败、明确 `connected:false` 和后端 0.6 秒失联租约仍可停止转动。
- 本机基线和更新副本：`D:\page change\.codex-backups\20261027-a2-position`。
- 本次车端备份：`/home/ubuntu/CAR_ws/camera_ui_backups/index.before-a2-position-20261027.html`。
- 19 项隔离测试含持续 12 秒续期、状态查询连续异常及超时、松手保留位置和端点反向。真实网页只做显示验证，没有进行实机转动测试。

## 同日更新：移除无人机云台摄像头模块

- 从车端页面移除 `uavCard`、专属 CSS 和独立脚本，关闭该页面发起的无人机视频重连、状态轮询、拍照和云台控制。
- 生效范围仅此车端网页，后端接口与巡检总览的无人机功能不变；小车 A2 相机、摇杆和其他控制脚本保持原样。
- 生成命令：`python vehicle-ui/remove-uav-camera.py <车端最新页面副本> <新页面输出路径>`。
- 本机副本：`D:\page change\.codex-backups\20261027-remove-uav-camera`；车端备份：`/home/ubuntu/CAR_ws/camera_ui_backups/index.before-remove-uav-camera-20261027.html`。
