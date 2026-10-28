# A8 机端相机服务存档

2026-10-28 从主机名已核对为 `uavpi` 的树莓派读取。目录结构对应机端绝对路径，包含当前 `server.py` 和用户级 `a8-h100-preview.service`，不是完整 A8 工程。原工程的 `index.html`、`gimbal_bridge.py`、FFmpeg 和相机网络仍需保留；本次只修改视频恢复逻辑。

## 环境与接口

- H100 网口：`192.168.50.3/24`，HTTP 服务绑定 `192.168.50.3:8870`。
- A8 视频源：`rtsp://192.168.144.25:8554/main.264`；相机侧网口需可访问该地址。
- `/stream` 为 640×360、10 fps MJPEG，`/api/status` 为状态，`/snapshot.jpg` 只返回新鲜帧。
- 电脑前端默认经本机后端直接读取 `192.168.50.3:8870/stream`；显式清空 `UavVideoUrl` 才使用小车 `192.168.50.2:8765/api/uav/stream` 转发。只下载本目录不能建立完整图传链路。

## 本次修复

解码器退出有超时和强制回收；连接时恢复失效 worker；超过 3 秒的旧帧不报告 live；断流结束 MJPEG 请求并释放客户端，避免重复发送缓存画面。机端仅重启了 A8 预览服务。

归档 `server.py` 原始下载字节的 SHA256：`9283cc9117cb69fe087dea86c835d48667ee902f28808fc33169f5a505eadf4a`。Git 的换行转换可能改变检出文件的字节校验值。

## 验证与重新部署

仓库根目录运行以下隔离验证，不启动 FFmpeg 或 HTTP 服务，也不访问设备：

```powershell
python "机端部署文件/tests/test_a8_recovery.py"
```

五项验证覆盖解码器强制回收、旧帧状态、失效 worker 恢复、拒绝过期 JPEG、同帧不重复及客户端清理。实机验证时前端小车 5.062 秒收到 63 个不同 JPEG；A8 8 秒采样收到 86 个不同 JPEG，包含连接启动总耗时为 10.875 秒。这是当次短时结果。

`tools/patch-a8-recovery.py` 是本次实际使用的修复脚本，只适用于检查过的既有 `server.py`：逐段匹配，先运行五项隔离验证，再备份并原子写入；源文件不同会停止，已带修复标记时跳过。它不负责重启服务。重新部署前核对当前设备身份、文件差异及依赖，避免覆盖其他人的后续修改。

本次设备上保留的修复前文件为 `/home/pi/a8mini/h100-web/backups/server.before-h100-recovery-531568cc99ac.py`。若需回滚，应先保存当前文件，再把该备份恢复至原路径，并以设备用户执行 `systemctl --user restart a8-h100-preview.service`。备份仅存在于本次设备，不随仓库提供。

## 2026-10-28 逐帧时间验证

A8 状态增加 server_time_ms、session_id 与 pi_jpeg_decode_complete 时间基准。每个 JPEG part 携带 X-Frame-Id、X-Frame-Decoded-At-Ms 和 X-Frame-Session；源时间与JPEG在同一锁内获取。只重启了 a8-h100-preview.service。备份：`/home/pi/a8mini/h100-web/backups/server.before-frame-timing-9283cc9117cb.py`。

本机默认直接通过 H100 读取该服务，避免经过车端。后端观察完整 JPEG 后记录本机接收时间，使用状态请求中点校正两机时钟、保留半 RTT 误差，拒绝重复帧续期、会话不匹配和旧采样。页面“采样”是机端完成 JPEG 解码时间，**不是曝光时间**；延迟也不包含相机内部编码或浏览器绘制。

当次直接链路 12 次采样全有效，多数延迟27–83 ms，抖动时约1.2秒，不能承诺恒定延迟。后端106项测试通过，帧解析验证覆盖分块/完整帧/重复/缺失/过期/时钟偏差。

18:14–18:16 复查仍见源端间歇断帧、自动重连，18:17:39 页面恢复“帧时间已校验”及约57 ms。机端实测温度83.2°C、`get_throttled=0xe0008`，仅发现一个 FFmpeg RTSP 会话；相机侧4次ping均成功。这些现象尚不足以确定断帧根因，不能宣称源端断流完全消除。FFmpeg stderr 当前不留存，历史错误不可回溯。
