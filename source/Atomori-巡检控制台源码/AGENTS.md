# 设备连接状态

- 用户于 2026-10-11 要求断开无人机树莓派，直到用户明确发出“连接”指令才恢复。此前不要尝试无人机树莓派的 SSH、HTTP、图传、遥测或自动重连。
- `backend/start-connected.ps1` 默认启用 `DisconnectUav`，保留车端及本机 Mission Planner 接入。收到明确恢复指令后，才可关闭此开关并更新本条状态。
