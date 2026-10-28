"""Bounded, read-only ROS telemetry collection. No ROS imports, services or publishers.

Units follow the ROS messages; values are never rescaled by magnitude guesses.
All reception ages use monotonic time, independently of the heartbeat gate.
"""
from collections import deque
from itertools import islice
import math
import threading
import time


def number(value):
    # ROS uint8 may arrive as a single byte, depending on generated bindings.
    if isinstance(value, bytes) and len(value) == 1:
        return value[0]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def member(value, path, default=None):
    for key in path.split('.') if path else ():
        try:
            value = value[int(key)] if key.isdigit() else value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)
        except (IndexError, KeyError, TypeError):
            return default
        if value is None:
            return default
    return value


def bounded_json(value, depth=0, budget=None):
    """Diagnostic data only: finite JSON, at most 256 nodes / 32 array items."""
    if budget is None:
        budget = [256]
    budget[0] -= 1
    if budget[0] < 0 or depth > 6:
        return '[truncated]'
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return number(value)
    if isinstance(value, str):
        return value[:512]
    if isinstance(value, bytes):
        return value[0] if len(value) == 1 else list(value[:32])
    if isinstance(value, dict):
        return {str(k)[:80]: bounded_json(v, depth + 1, budget) for k, v in islice(value.items(), 48)}
    if hasattr(value, 'get_fields_and_field_types'):
        return {k: bounded_json(getattr(value, k), depth + 1, budget)
                for k in list(value.get_fields_and_field_types())[:48]}
    if hasattr(value, '__dict__'):
        return bounded_json(vars(value), depth + 1, budget)
    try:
        return [bounded_json(v, depth + 1, budget) for v in islice(value, 32)]
    except TypeError:
        return str(value)[:128]


def field(key, label, path, unit='', digits=2, scale=1, lower=None, upper=None, sentinels=(), gate=None, boolean=False):
    return dict(key=key, label=label, path=path, unit=unit, digits=digits, scale=scale,
                lower=lower, upper=upper, sentinels=sentinels, gate=gate, boolean=boolean)


def axes(prefix, label, path, unit, digits=3, **kwargs):
    return [field(prefix + a.upper(), label + ' ' + a.upper(), path + '.' + a, unit, digits, **kwargs) for a in 'xyz']


def covariance_available(path):
    return lambda message: member(message, path + '.0') != -1


def position_fix(message):
    status = number(member(message, 'status.status'))
    return status is not None and status >= 0


def raw_fix(message):
    fix = number(member(message, 'fix_type'))
    return fix is not None and fix >= 2


ESTIMATOR_FLAGS = [
    'attitude_status_flag', 'velocity_horiz_status_flag', 'velocity_vert_status_flag',
    'pos_horiz_rel_status_flag', 'pos_horiz_abs_status_flag', 'pos_vert_abs_status_flag',
    'pos_vert_agl_status_flag', 'const_pos_mode_status_flag', 'pred_pos_horiz_rel_status_flag',
    'pred_pos_horiz_abs_status_flag', 'gps_glitch_status_flag', 'accel_error_status_flag',
]
ESTIMATOR_LABELS = ['姿态估计', '水平速度估计', '垂直速度估计', '相对水平位置', '绝对水平位置',
    '绝对垂直位置', '对地垂直位置', '恒定位置模式', '预测相对水平位置', '预测绝对水平位置', 'GPS 异常标志', '加速度异常标志']

# Confirmed by get_publishers_info_by_topic on the deployed Humble MAVROS.
RETAINED_TOPICS = {'/mavros/home_position/home', '/mavros/global_position/gp_origin',
                   '/mavros/mission/waypoints', '/mavros/mission/reached', '/mavros/sys_status'}


def schema():
    sources = {}
    def add(topic, message_type, group, age, fields=(), existing=False):
        sources[topic] = dict(topic=topic, message_type=message_type, group=group, max_age_s=age,
                              fields=list(fields), existing=existing)
    battery_present = lambda m: member(m, 'present') is True
    add('/mavros/battery', 'sensor_msgs/msg/BatteryState', '电池', 3, [
        field('batteryCurrent', '电池电流（保留 ROS 符号）', 'current', 'A', gate=battery_present),
        field('batteryTemperature', '电池温度', 'temperature', '°C', 1, gate=battery_present),
        field('batteryCharge', '电池剩余电荷', 'charge', 'Ah', 3, lower=0, gate=battery_present),
        field('batteryCapacity', '电池容量', 'capacity', 'Ah', 3, lower=0, gate=battery_present),
        field('batteryDesignCapacity', '电池设计容量', 'design_capacity', 'Ah', 3, lower=0, gate=battery_present),
        field('batteryPresent', '电池存在标志', 'present', digits=0, boolean=True),
        field('batterySupplyStatus', '电池供电状态代码', 'power_supply_status', digits=0, lower=0, upper=4),
        field('batteryHealth', '电池健康状态代码', 'power_supply_health', digits=0, lower=0, upper=8),
        field('batteryTechnology', '电池类型代码', 'power_supply_technology', digits=0, lower=0, upper=6),
        # Some FCUs populate cell_voltage[0] with the pack voltage. Keep the
        # declared array channel without claiming a verified physical cell.
        *[field(f'batteryCell{i}', f'电池上报电压通道 {i}（单体含义未核验）', f'cell_voltage.{i-1}', 'V', 3, lower=0.01, gate=battery_present) for i in range(1, 17)],
        *[field(f'batteryCellTemperature{i}', f'电池上报温度通道 {i}', f'cell_temperature.{i-1}', '°C', 1, gate=battery_present) for i in range(1, 17)],
    ], True)
    add('/mavros/vfr_hud', 'mavros_msgs/msg/VfrHud', '飞行仪表', 1, [
        field('airspeed', '空速', 'airspeed', 'm/s', lower=0), field('groundspeed', '地速', 'groundspeed', 'm/s', lower=0),
        field('vfrHeading', 'VFR 航向', 'heading', '°', 1), field('vfrClimb', 'VFR 爬升速度', 'climb', 'm/s'),
        field('vfrThrottle', 'VFR 油门输出', 'throttle', '%', 1, scale=100, lower=0, upper=100),
        field('vfrAltitude', 'VFR 海拔高度', 'altitude', 'm'),
    ], True)
    for direction, typ, prefix, group in [('in', 'RCIn', 'rcInput', '遥控输入'), ('out', 'RCOut', 'rcOutput', '舵机输出')]:
        channels = [field(f'{prefix}{i}', f'{group}通道 {i}', f'channels.{i-1}', 'µs', 0, lower=500, upper=2500, sentinels=(0, 65535)) for i in range(1, 33)]
        if direction == 'in':
            channels.append(field('rcRssi', '遥控接收信号强度（原始）', 'rssi', digits=0, lower=0, upper=254, sentinels=(255,)))
        add('/mavros/rc/' + direction, 'mavros_msgs/msg/' + typ, group, 2, channels, direction == 'in')
    add('/mavros/local_position/pose', 'geometry_msgs/msg/PoseStamped', '局部位置 ENU', 1,
        axes('localPosition', '局部位置', 'pose.position', 'm') + [field('poseQuaternion' + a.upper(), '姿态四元数 ' + a.upper(), 'pose.orientation.' + a, digits=5, lower=-1, upper=1) for a in 'xyzw'], True)
    add('/mavros/local_position/velocity_local', 'geometry_msgs/msg/TwistStamped', '局部速度 ENU', 1,
        axes('localVelocity', '局部线速度', 'twist.linear', 'm/s') + axes('localAngularVelocity', '局部角速度', 'twist.angular', 'rad/s'), True)
    add('/mavros/local_position/velocity_body', 'geometry_msgs/msg/TwistStamped', '机体系速度 FLU', 1,
        axes('bodyVelocity', '机体系线速度', 'twist.linear', 'm/s', gate=lambda m: member(m, 'header.frame_id') in ('base_link', 'BODY_FLU'))
        + axes('bodyAngularVelocity', '机体系角速度', 'twist.angular', 'rad/s', gate=lambda m: member(m, 'header.frame_id') in ('base_link', 'BODY_FLU')), True)
    add('/mavros/local_position/accel', 'geometry_msgs/msg/AccelWithCovarianceStamped', '局部加速度', 1,
        axes('localAcceleration', '局部线加速度', 'accel.accel.linear', 'm/s²') + axes('localAngularAcceleration', '局部角加速度', 'accel.accel.angular', 'rad/s²'))
    add('/mavros/imu/data', 'sensor_msgs/msg/Imu', 'IMU', 0.5, [field('imuQuaternion' + a.upper(), 'IMU 四元数 ' + a.upper(), 'orientation.' + a, digits=5, lower=-1, upper=1, gate=covariance_available('orientation_covariance')) for a in 'xyzw'], True)
    add('/mavros/imu/data_raw', 'sensor_msgs/msg/Imu', '原始 IMU', 0.5,
        axes('rawGyro', '原始角速度（FLU）', 'angular_velocity', 'rad/s', 5, gate=covariance_available('angular_velocity_covariance'))
        + axes('rawAccel', '原始加速度（FLU）', 'linear_acceleration', 'm/s²', gate=covariance_available('linear_acceleration_covariance')))
    add('/mavros/imu/mag', 'sensor_msgs/msg/MagneticField', '磁场', 1,
        axes('magneticField', '磁场', 'magnetic_field', 'T', 7, lower=-0.01, upper=0.01, gate=covariance_available('magnetic_field_covariance')))
    for suffix, key, label, lower in [('static_pressure', 'staticPressure', '静压', 0), ('diff_pressure', 'differentialPressure', '差压', None)]:
        add('/mavros/imu/' + suffix, 'sensor_msgs/msg/FluidPressure', '气压', 3, [field(key, label, 'fluid_pressure', 'Pa', 1, lower=lower)])
    for suffix, key, label in [('temperature_baro', 'barometerTemperature', '气压计温度'), ('temperature_imu', 'imuTemperature', 'IMU 温度')]:
        add('/mavros/imu/' + suffix, 'sensor_msgs/msg/Temperature', '温度', 3, [field(key, label, 'temperature', '°C', 2)])
    for topic, prefix, label in [('/mavros/global_position/raw/fix', 'gpsRaw', 'GPS 原始'), ('/mavros/global_position/global', '', '全球位置')]:
        names = ['latitude', 'longitude', 'gpsAltitude'] if not prefix else [prefix + 'Latitude', prefix + 'Longitude', prefix + 'Altitude']
        add(topic, 'sensor_msgs/msg/NavSatFix', 'GPS', 3, [
            field(names[0], label + '纬度', 'latitude', '°', 7, lower=-90, upper=90, gate=position_fix),
            field(names[1], label + '经度', 'longitude', '°', 7, lower=-180, upper=180, gate=position_fix),
            field(names[2], label + '高度（椭球）', 'altitude', 'm', gate=position_fix),
            field((prefix or 'global') + 'FixStatus', label + '定位状态代码', 'status.status', digits=0, lower=-1, upper=2),
            field((prefix or 'global') + 'Service', label + '星座位标志', 'status.service', digits=0),
        ])
    add('/mavros/global_position/raw/satellites', 'std_msgs/msg/UInt32', 'GPS', 3, [field('satellites', 'GPS 卫星数', 'data', digits=0, lower=0, upper=254, sentinels=(255,))])
    add('/mavros/global_position/raw/gps_vel', 'geometry_msgs/msg/TwistStamped', 'GPS', 3, axes('gpsVelocity', 'GPS 速度', 'twist.linear', 'm/s'))
    for index in (1, 2):
        prefix = 'gps' + str(index)
        add('/mavros/gpsstatus/gps%d/raw' % index, 'mavros_msgs/msg/GPSRAW', 'GPS', 3, [
            field('gpsFix' if index == 1 else prefix + 'Fix', 'GPS%d 定位等级' % index, 'fix_type', digits=0, lower=0, upper=8),
            field(prefix + 'Latitude', 'GPS%d 纬度' % index, 'lat', '°', 7, scale=1e-7, lower=-90, upper=90, gate=raw_fix),
            field(prefix + 'Longitude', 'GPS%d 经度' % index, 'lon', '°', 7, scale=1e-7, lower=-180, upper=180, gate=raw_fix),
            field(prefix + 'AltitudeMsl', 'GPS%d 海拔高度' % index, 'alt', 'm', scale=0.001, gate=raw_fix),
            field('hdop' if index == 1 else prefix + 'Hdop', 'GPS%d HDOP' % index, 'eph', scale=0.01, lower=0, sentinels=(65535,)),
            field(prefix + 'Vdop', 'GPS%d VDOP' % index, 'epv', scale=0.01, lower=0, sentinels=(65535,)),
            field(prefix + 'Groundspeed', 'GPS%d 地速' % index, 'vel', 'm/s', scale=0.01, lower=0, sentinels=(65535,), gate=raw_fix),
            field(prefix + 'Course', 'GPS%d 航迹角' % index, 'cog', '°', scale=0.01, lower=0, upper=360, sentinels=(65535,), gate=raw_fix),
            field(prefix + 'Satellites', 'GPS%d 卫星数' % index, 'satellites_visible', digits=0, lower=0, upper=254, sentinels=(255,)),
        ])
        add('/mavros/gpsstatus/gps%d/rtk' % index, 'mavros_msgs/msg/GPSRTK', 'RTK', 3)
    add('/mavros/sys_status', 'mavros_msgs/msg/SysStatus', '飞控系统', 3, [
        field('cpuLoad', '飞控负载', 'load', '%', 1, scale=0.1, lower=0, upper=100),
        field('systemVoltage', '系统状态电池电压', 'voltage_battery', 'V', 3, scale=0.001, lower=0.001, sentinels=(65535,)),
        field('systemCurrent', '系统状态电池电流', 'current_battery', 'A', scale=0.01, sentinels=(-1,)),
        field('systemBatteryRemaining', '系统状态电量', 'battery_remaining', '%', 0, lower=0, upper=100, sentinels=(-1,)),
        field('communicationDropRate', '通信丢包率', 'drop_rate_comm', '%', 2, scale=0.01, lower=0, upper=100),
        *[field('system' + name.title().replace('_', ''), label, name, digits=0, lower=0) for name, label in [
            ('sensors_present', '传感器存在位标志'), ('sensors_enabled', '传感器启用位标志'), ('sensors_health', '传感器健康位标志'),
            ('errors_comm', '通信错误计数'), ('errors_count1', '错误计数 1'), ('errors_count2', '错误计数 2'), ('errors_count3', '错误计数 3'), ('errors_count4', '错误计数 4')]],
    ])
    add('/mavros/estimator_status', 'mavros_msgs/msg/EstimatorStatus', '估计器', 3,
        [field('ekf' + str(i), label, name, digits=0, boolean=True) for i, (name, label) in enumerate(zip(ESTIMATOR_FLAGS, ESTIMATOR_LABELS))]
        + [field('ekfFlags', '估计器状态位标志', '_flags', digits=0)])
    add('/mavros/statustext/recv', 'mavros_msgs/msg/StatusText', '飞控消息', 30)
    for topic, prefix, group, existing in [('/landing/sensor_range', 'landingRange', '着陆测距', True),
            ('/mavros/optical_flow/ground_distance', 'opticalFlowRange', '光流测距', False),
            ('/mavros/rangefinder/rangefinder', 'fcuRange', '飞控测距', False),
            ('/mavros/rangefinder_pub', 'rangefinderPub', '飞控测距', False)]:
        def in_range(m):
            v, lo, hi = number(member(m, 'range')), number(member(m, 'min_range')), number(member(m, 'max_range'))
            return all(x is not None for x in (v, lo, hi)) and lo <= v <= hi
        add(topic, 'sensor_msgs/msg/Range', group, 1, [field(prefix, group + '距离（沿传感器轴）', 'range', 'm', 3, lower=0, gate=in_range)], existing)
    add('/mavros/optical_flow/raw/optical_flow', 'mavros_msgs/msg/OpticalFlow', '光流', 1,
        axes('opticalFlow', '原始光流', 'flow', 'dpix')[:2] + axes('opticalFlowRate', '光流角速率', 'flow_rate', 'rad/s')[:2]
        + axes('opticalFlowCompensated', '光流补偿速度', 'flow_comp_m', 'm/s')[:2]
        + [field('opticalFlowQuality', '光流质量', 'quality', digits=0, lower=0, upper=255), field('opticalFlowDistance', '光流距离', 'ground_distance', 'm', lower=0)])
    add('/mavros/home_position/home', 'mavros_msgs/msg/HomePosition', 'Home 基准', 10,
        [field('homeLatitude', 'Home 纬度', 'geo.latitude', '°', 7, lower=-90, upper=90), field('homeLongitude', 'Home 经度', 'geo.longitude', '°', 7, lower=-180, upper=180), field('homeAltitude', 'Home 椭球高度', 'geo.altitude', 'm')]
        + axes('homeLocalPosition', 'Home 局部位置', 'position', 'm') + axes('homeApproach', 'Home 进近方向', 'approach', 'm'))
    add('/mavros/nav_controller_output/output', 'mavros_msgs/msg/NavControllerOutput', '导航控制器', 2, [
        field(key, label, path, unit) for key, label, path, unit in [
            ('navRoll', '导航横滚目标', 'nav_roll', '°'), ('navPitch', '导航俯仰目标', 'nav_pitch', '°'),
            ('navBearing', '导航方位', 'nav_bearing', '°'), ('targetBearing', '目标方位', 'target_bearing', '°'),
            ('waypointDistance', '航点距离', 'wp_dist', 'm'), ('navigationAltitudeError', '导航高度误差', 'alt_error', 'm'),
            ('navigationAirspeedError', '导航空速误差', 'aspd_error', 'm/s'), ('crossTrackError', '航迹横向误差', 'xtrack_error', 'm')]])
    for suffix, typ in [('target_local', 'PositionTarget'), ('target_global', 'GlobalPositionTarget')]:
        prefix = 'targetLocal' if suffix.endswith('local') else 'targetGlobal'
        def mask_clear(bit):
            return lambda m: number(member(m, 'type_mask')) is not None and not (int(number(member(m, 'type_mask'))) & bit)
        fields = []
        for path, part, unit, bits in [('velocity', 'Velocity', 'm/s', [8, 16, 32]), ('acceleration_or_force', 'AccelerationOrForce', '', [64, 128, 256])]:
            fields.extend(field(prefix + part + a.upper(), '回传目标 ' + part + ' ' + a.upper(), path + '.' + a, unit, 3, gate=mask_clear(bit)) for a, bit in zip('xyz', bits))
        if typ == 'PositionTarget':
            fields.extend(field(prefix + 'Position' + a.upper(), '回传局部目标位置 ' + a.upper(), 'position.' + a, 'm', gate=mask_clear(bit)) for a, bit in zip('xyz', [1, 2, 4]))
        else:
            fields.extend([field(prefix + 'Latitude', '回传全球目标纬度', 'latitude', '°', 7, gate=mask_clear(1)), field(prefix + 'Longitude', '回传全球目标经度', 'longitude', '°', 7, gate=mask_clear(2)), field(prefix + 'Altitude', '回传全球目标高度（见坐标系）', 'altitude', 'm', gate=mask_clear(4))])
        fields.extend([field(prefix + 'Yaw', '回传目标偏航', 'yaw', 'rad', 3, gate=mask_clear(1024)), field(prefix + 'YawRate', '回传目标偏航角速率', 'yaw_rate', 'rad/s', 3, gate=mask_clear(2048)), field(prefix + 'Frame', '回传目标坐标系代码', 'coordinate_frame', digits=0), field(prefix + 'Mask', '回传目标忽略位掩码', 'type_mask', digits=0)])
        add('/mavros/setpoint_raw/' + suffix, 'mavros_msgs/msg/' + typ, '飞控回传目标', 1, fields)
    add('/mavros/setpoint_raw/target_attitude', 'mavros_msgs/msg/AttitudeTarget', '飞控回传目标', 1,
        [field('targetAttitudeThrust', '回传姿态目标推力比例', 'thrust', '%', 1, scale=100, lower=0, upper=100, gate=lambda m: not (int(number(member(m, 'type_mask')) or 0) & 64))]
        + [field('targetAttitudeRate' + a.upper(), '回传角速率目标 ' + a.upper(), 'body_rate.' + a, 'rad/s', 3, gate=lambda m, b=b: not (int(number(member(m, 'type_mask')) or 0) & b)) for a, b in zip('xyz', [1, 2, 4])]
        + [field('targetAttitudeQuaternion' + a.upper(), '回传姿态目标四元数 ' + a.upper(), 'orientation.' + a, digits=5, lower=-1, upper=1, gate=lambda m: not (int(number(member(m, 'type_mask')) or 0) & 128)) for a in 'xyzw'])
    for topic, typ, path, fields in [('/mavros/esc_status/status', 'ESCStatus', 'esc_status', [('Rpm', 'rpm', 'rpm'), ('Voltage', 'voltage', 'V'), ('Current', 'current', 'A')]),
            ('/mavros/esc_telemetry/telemetry', 'ESCTelemetry', 'esc_telemetry', [('Rpm', 'rpm', 'rpm'), ('Voltage', 'voltage', 'V'), ('Current', 'current', 'A'), ('Temperature', 'temperature', '°C'), ('TotalCurrent', 'totalcurrent', 'Ah'), ('Count', 'count', '')])]:
        prefix = 'escStatus' if typ == 'ESCStatus' else 'escTelemetry'
        add(topic, 'mavros_msgs/msg/' + typ, '电调', 3, [field(prefix + str(i) + suffix, f'电调 {i} ' + suffix, f'{path}.{i-1}.{name}', unit, 1) for i in range(1, 9) for suffix, name, unit in fields])
    add('/mavros/esc_status/info', 'mavros_msgs/msg/ESCInfo', '电调', 10)
    add('/mavros/radio_status', 'mavros_msgs/msg/RadioStatus', '数传', 3, [field('radio' + name.title().replace('_', ''), '数传 ' + name, name, 'dBm' if name.endswith('dbm') else '', 1 if name.endswith('dbm') else 0) for name in ['rssi', 'remrssi', 'txbuf', 'noise', 'remnoise', 'rxerrors', 'fixed', 'rssi_dbm', 'remrssi_dbm']])
    add('/mavros/terrain/report', 'mavros_msgs/msg/TerrainReport', '地形估计', 3, [field('terrainHeight', '地形海拔', 'terrain_height', 'm'), field('terrainCurrentHeight', '地形相对高度估计（非测距）', 'current_height', 'm')])
    # These sources contain structured telemetry; the bounded diagnostic table exposes
    # all fields without pretending arbitrary values are calibrated measurements.
    for topic, typ, group, age in [
        ('/mavros/local_position/odom', 'nav_msgs/msg/Odometry', '局部里程计', 1),
        ('/mavros/global_position/local', 'nav_msgs/msg/Odometry', '全球里程计', 3),
        ('/mavros/global_position/gp_origin', 'geographic_msgs/msg/GeoPointStamped', '全球坐标原点', 10),
        ('/mavros/wind_estimation', 'geometry_msgs/msg/TwistWithCovarianceStamped', '风速估计', 3),
        ('/mavros/mission/waypoints', 'mavros_msgs/msg/WaypointList', '任务航点', 10),
        ('/mavros/mission/reached', 'mavros_msgs/msg/WaypointReached', '任务航点', 10),
        ('/mavros/timesync_status', 'mavros_msgs/msg/TimesyncStatus', '时间同步', 3),
        ('/mavros/time_reference', 'sensor_msgs/msg/TimeReference', '时间同步', 3),
        ('/diagnostics', 'diagnostic_msgs/msg/DiagnosticArray', '节点诊断（非飞控自检）', 3),
    ]:
        add(topic, typ, group, age)
    for topic, typ, group, age in [('/mavros/state', 'mavros_msgs/msg/State', '飞控状态', 2), ('/mavros/extended_state', 'mavros_msgs/msg/ExtendedState', '飞行状态', 2),
        ('/mavros/global_position/compass_hdg', 'std_msgs/msg/Float64', '航向', 0.5), ('/mavros/global_position/rel_alt', 'std_msgs/msg/Float64', '相对 Home 高度', 3),
        ('/mavros/setpoint_raw/local', 'mavros_msgs/msg/PositionTarget', '上行指令观测', 0.5), ('/landing/action/status', 'std_msgs/msg/String', '动作执行器', 2)]:
        add(topic, typ, group, age, existing=True)
    add('MAVLink/VIBRATION (未发现只读 ROS 来源)', 'unavailable', '振动', 3, axes('vibration', '振动', 'vibration', 'm/s²'))
    return sources


class FlightTelemetry:
    def __init__(self, clock=time.monotonic, wall_clock=time.time):
        self.clock = clock
        self.wall_clock = wall_clock
        self.lock = threading.Lock()
        self.specs = schema()
        self.sources = {topic: dict(count=0, received=None, data=None, error=None, initial_age=0) for topic in self.specs}
        self.values = {}
        self.topic_aliases = {}
        self.health = []
        self.health_received = None
        self.alerts = deque(maxlen=32)

    def remap(self, canonical_topic, actual_topic):
        if canonical_topic == actual_topic:
            return
        spec = self.specs.pop(canonical_topic)
        spec['topic'] = actual_topic
        self.specs[actual_topic] = spec
        self.sources[actual_topic] = self.sources.pop(canonical_topic)
        self.topic_aliases[canonical_topic] = actual_topic

    def unavailable(self, topic, error):
        with self.lock:
            self.sources[topic]['error'] = str(error)[:160]

    def observe(self, topic, message):
        topic = self.topic_aliases.get(topic, topic)
        if topic not in self.specs:
            return
        spec = self.specs[topic]
        now = self.clock()
        initial_age = 0
        if topic in RETAINED_TOPICS:
            sec = number(member(message, 'header.stamp.sec'))
            nanosec = number(member(message, 'header.stamp.nanosec'))
            stamp = sec + nanosec / 1e9 if sec is not None and nanosec is not None and 0 <= nanosec < 1e9 else None
            # A retained message may have been produced long before this subscriber
            # started. Reception is not a new hardware sample or new health result.
            delta = self.wall_clock() - stamp if stamp is not None and stamp > 0 else None
            initial_age = max(0, delta) if delta is not None and delta >= -0.1 else None
        data = bounded_json(message)
        values = {}
        for f in spec['fields']:
            raw = member(message, f['path'])
            if f['key'] == 'ekfFlags':
                flags = [member(message, name) for name in ESTIMATOR_FLAGS]
                raw = sum((1 << i) for i, v in enumerate(flags) if v) if all(isinstance(v, bool) for v in flags) else None
            value = int(raw) if f['boolean'] and isinstance(raw, bool) else number(raw)
            reason = 'VALID'
            if value is None or value in f['sentinels']:
                reason = 'INVALID'
            else:
                value *= f['scale']
                if not math.isfinite(value) or (f['lower'] is not None and value < f['lower']) or (f['upper'] is not None and value > f['upper']):
                    reason = 'OUT_OF_RANGE'
                elif f['gate'] is not None and not f['gate'](message):
                    reason = 'INVALID'
            values[f['key']] = dict(value=value if reason == 'VALID' else None, raw_value=bounded_json(raw), reason=reason)
        health = None
        if topic == '/mavros/sys_status':
            masks = [number(member(message, name)) for name in ['sensors_present', 'sensors_enabled', 'sensors_health']]
            if all(v is not None and 0 <= v <= 0xffffffff for v in masks):
                present, enabled, healthy = map(int, masks)
                health = [dict(label=label, state='未安装 / 未报告' if not present & bit else '未启用' if not enabled & bit else '正常' if healthy & bit else '异常 / 未通过', source=topic)
                          for label, bit in [('陀螺仪', 1), ('加速度计', 2), ('磁力计', 4), ('气压计', 8), ('差压计', 16), ('GPS', 32), ('预解锁检查', 1 << 28)]]
        alert = None
        if topic == '/mavros/statustext/recv':
            text, severity = member(message, 'text'), number(member(message, 'severity'))
            if isinstance(text, str) and text and severity is not None and 0 <= severity <= 7:
                alert = dict(severity=int(severity), text=text[:512], received=now)
        with self.lock:
            source = self.sources[topic]
            source.update(count=source['count'] + 1, received=now, data=data, error=None, initial_age=initial_age)
            self.values.update(values)  # Every registered channel is replaced, including absent channels.
            if topic == '/mavros/sys_status':
                self.health, self.health_received = health or [], now - initial_age if health is not None and initial_age is not None else None
            if alert:
                self.alerts.append(alert)

    def snapshot(self, connected):
        now = self.clock()
        with self.lock:
            metrics, sources = {}, []
            for topic, spec in self.specs.items():
                state = self.sources[topic]
                received_age = None if state['received'] is None else max(0, now - state['received'])
                age = received_age + state['initial_age'] if received_age is not None and state['initial_age'] is not None else None
                status = 'NOT_AVAILABLE' if spec['message_type'] == 'unavailable' else 'UNSUPPORTED_TYPE' if state['error'] else 'NO_SAMPLE' if not state['count'] else 'INVALID' if age is None else 'STALE' if age > spec['max_age_s'] else 'RECEIVING'
                age_basis = 'ros_header_age_and_bridge_receive' if topic in RETAINED_TOPICS else 'bridge_receive_monotonic'
                sources.append(dict(topic=topic, message_type=spec['message_type'], count=state['count'], age_s=age, received_age_s=received_age,
                    age_basis=age_basis, max_age_s=spec['max_age_s'], status=status, data=state['data'], error=state['error']))
                for f in spec['fields']:
                    sample = self.values.get(f['key'], {})
                    reason = 'NO_SAMPLE' if not state['count'] else 'FLIGHT_CONTROLLER_DISCONNECTED' if not connected else 'INVALID' if age is None else 'STALE' if age > spec['max_age_s'] else sample.get('reason', 'INVALID')
                    metrics[f['key']] = dict(label=f['label'], group=spec['group'], unit=f['unit'], digits=f['digits'],
                        value=sample.get('value') if reason == 'VALID' else None, raw_value=sample.get('raw_value'),
                        source=topic + '.' + f['path'], age_s=age, age_basis=age_basis, max_age_s=spec['max_age_s'], valid=reason == 'VALID', reason=reason)
            health_age = None if self.health_received is None else max(0, now - self.health_received)
            health = list(self.health) if connected and health_age is not None and health_age <= 3 else []
            alerts = [dict(severity=a['severity'], text=a['text'], age_s=max(0, now-a['received'])) for a in self.alerts if connected and now-a['received'] <= 30]
        return dict(extra_metrics=metrics, telemetry_sources=sources, health=health, health_age_s=health_age, alerts=alerts)

    def subscribe(self, node):
        """Add only observer subscriptions; preserve existing callbacks and their QoS."""
        from rosidl_runtime_py.utilities import get_message
        from rclpy.qos import qos_profile_sensor_data, QoSProfile, ReliabilityPolicy, DurabilityPolicy
        retained_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        subscriptions = []
        for topic, spec in self.specs.items():
            if spec['existing'] or spec['message_type'] == 'unavailable':
                continue
            try:
                message_type = get_message(spec['message_type'])
                subscriptions.append(node.create_subscription(message_type, topic,
                    lambda message, topic=topic: self.observe(topic, message), retained_qos if topic in RETAINED_TOPICS else qos_profile_sensor_data))
            except Exception as error:
                # Optional ROS types/QoS failures must not stop the existing IMU bridge.
                self.unavailable(topic, type(error).__name__ + ': ' + str(error))
        return subscriptions
