"""Isolated observer tests: no ROS runtime, network, publications or hardware."""
import json
import sys
import types
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

from flight_telemetry import FlightTelemetry, ESTIMATOR_FLAGS, bounded_json


def vec(x=0, y=0, z=0):
    return NS(x=x, y=y, z=z)


class FullTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.registry = FlightTelemetry(lambda: self.now, lambda: 1000.0)

    def metrics(self, connected=True):
        return self.registry.snapshot(connected)['extra_metrics']

    def test_no_sample_registers_all_sources_without_inventing_data(self):
        result = self.registry.snapshot(True)
        self.assertGreater(len(result['telemetry_sources']), 40)
        for key in ['batteryCurrent', 'airspeed', 'groundspeed', 'latitude', 'longitude', 'gpsFix', 'satellites', 'hdop', 'cpuLoad', 'ekfFlags', 'vibrationX', 'rcInput1', 'rcOutput1', 'batteryCell1']:
            self.assertEqual(result['extra_metrics'][key]['reason'], 'NO_SAMPLE')
            self.assertIsNone(result['extra_metrics'][key]['value'])
        self.assertEqual(result['health'], [])
        self.assertIsNone(result['health_age_s'])
        self.assertEqual(result['alerts'], [])
        self.assertLess(len(json.dumps(result, allow_nan=False)), 200_000)

    def test_negative_current_and_pack_voltage_channel_are_preserved(self):
        self.registry.observe('/mavros/battery', NS(present=True, current=-1.09, cell_voltage=[9.539], temperature=float('nan')))
        values = self.metrics()
        self.assertEqual(values['batteryCurrent']['value'], -1.09)
        self.assertEqual(values['batteryCell1']['value'], 9.539)
        self.assertIn('单体含义未核验', values['batteryCell1']['label'])
        self.assertEqual(values['batteryTemperature']['reason'], 'INVALID')
        self.assertIsNone(values['batteryTemperature']['raw_value'])
        self.registry.observe('/mavros/battery', NS(present=False, current=-1.09, cell_voltage=[9.539]))
        self.assertIsNone(self.metrics()['batteryCurrent']['value'])
        self.assertEqual(self.metrics()['batteryPresent']['value'], 0)

    def test_disappearing_array_channels_are_invalidated_immediately(self):
        self.registry.observe('/mavros/rc/out', NS(channels=[1000, 1500, 0, 65535]))
        values = self.metrics()
        self.assertEqual(values['rcOutput1']['value'], 1000)
        self.assertEqual(values['rcOutput2']['value'], 1500)
        self.assertEqual(values['rcOutput3']['reason'], 'INVALID')
        self.assertEqual(values['rcOutput4']['raw_value'], 65535)
        self.registry.observe('/mavros/rc/out', NS(channels=[]))
        self.assertEqual(self.metrics()['rcOutput1']['reason'], 'INVALID')
        self.assertIsNone(self.metrics()['rcOutput2']['value'])
        self.registry.observe('/mavros/battery', NS(present=True, cell_voltage=[4, 4.1]))
        self.assertEqual(self.metrics()['batteryCell2']['value'], 4.1)
        self.registry.observe('/mavros/battery', NS(present=True, cell_voltage=[4]))
        self.assertIsNone(self.metrics()['batteryCell2']['value'])
        self.registry.observe('/mavros/rc/in', NS(channels=[], rssi=255))
        self.assertEqual(self.metrics()['rcRssi']['reason'], 'INVALID')

    def test_magnetic_anomaly_is_rejected_without_guessing_a_scale(self):
        self.registry.observe('/mavros/imu/mag', NS(magnetic_field=vec(75000, -182000, -145000), magnetic_field_covariance=[-1] + [0]*8))
        for axis, raw in [('X', 75000), ('Y', -182000), ('Z', -145000)]:
            item = self.metrics()['magneticField' + axis]
            self.assertEqual(item['reason'], 'OUT_OF_RANGE')
            self.assertIsNone(item['value'])
            self.assertEqual(item['raw_value'], raw)
            self.assertEqual(item['unit'], 'T')
        self.registry.observe('/mavros/imu/mag', NS(magnetic_field=vec(0.00005, 0, -0.00002), magnetic_field_covariance=[0]*9))
        self.assertEqual(self.metrics()['magneticFieldX']['value'], 0.00005)

    def test_covariance_and_body_frame_gates_do_not_assume_valid_sensors(self):
        self.registry.observe('/mavros/imu/data_raw', NS(angular_velocity=vec(1, 2, 3), angular_velocity_covariance=[-1]*9,
            linear_acceleration=vec(0, 0, 9.8), linear_acceleration_covariance=[0]*9))
        self.assertEqual(self.metrics()['rawGyroX']['reason'], 'INVALID')
        self.assertEqual(self.metrics()['rawAccelZ']['value'], 9.8)
        message = NS(header=NS(frame_id='unknown'), twist=NS(linear=vec(1, 2, 3), angular=vec()))
        self.registry.observe('/mavros/local_position/velocity_body', message)
        self.assertEqual(self.metrics()['bodyVelocityX']['reason'], 'INVALID')
        message.header.frame_id = 'base_link'
        self.registry.observe('/mavros/local_position/velocity_body', message)
        self.assertEqual(self.metrics()['bodyVelocityX']['value'], 1)

    def test_gps_fix_and_raw_sentinels_do_not_create_valid_coordinates(self):
        topic = '/mavros/global_position/global'
        message = NS(status=NS(status=-1, service=1), latitude=30, longitude=120, altitude=20)
        self.registry.observe(topic, message)
        self.assertEqual(self.metrics()['latitude']['reason'], 'INVALID')
        message.status.status = 0
        self.registry.observe(topic, message)
        self.assertEqual(self.metrics()['latitude']['value'], 30)
        self.registry.observe('/mavros/gpsstatus/gps1/raw', NS(fix_type=b'\x01', lat=300000000, lon=1200000000, alt=25000,
            eph=65535, epv=100, vel=65535, cog=65535, satellites_visible=b'\xff'))
        values = self.metrics()
        self.assertEqual(values['gpsFix']['value'], 1)
        self.assertEqual(values['gps1Latitude']['reason'], 'INVALID')
        self.assertIsNone(values['hdop']['value'])
        self.assertEqual(values['gps1Vdop']['value'], 1)
        self.assertIsNone(values['gps1Satellites']['value'])
        self.registry.observe('/mavros/gpsstatus/gps1/raw', NS(fix_type=3, lat=300000000, lon=1200000000, alt=25000, eph=120, epv=200, vel=150, cog=9000, satellites_visible=9))
        self.assertEqual(self.metrics()['gps1Latitude']['value'], 30)
        self.assertEqual(self.metrics()['hdop']['value'], 1.2)

    def test_source_age_heartbeat_and_measurement_age_are_independent(self):
        self.registry.observe('/mavros/battery', NS(present=True, current=-1))
        self.registry.observe('/mavros/imu/data_raw', NS(angular_velocity=vec(1, 2, 3), angular_velocity_covariance=[0]*9))
        self.now += 0.6
        self.assertEqual(self.metrics()['rawGyroX']['reason'], 'STALE')
        self.assertEqual(self.metrics()['batteryCurrent']['value'], -1)
        self.assertEqual(self.metrics(False)['batteryCurrent']['reason'], 'FLIGHT_CONTROLLER_DISCONNECTED')
        self.now += 3
        self.assertEqual(self.metrics()['batteryCurrent']['reason'], 'STALE')
        self.assertEqual(self.metrics()['latitude']['reason'], 'NO_SAMPLE')

    def test_health_uses_actual_sys_status_not_imu_or_node_diagnostics(self):
        self.registry.observe('/diagnostics', NS(status=[NS(name='mavros: System', level=0, message='Normal')]))
        self.assertEqual(self.registry.snapshot(True)['health'], [])
        self.registry.observe('/mavros/sys_status', NS(header=NS(stamp=NS(sec=1000, nanosec=0)), sensors_present=1|2|4, sensors_enabled=1|2, sensors_health=1,
            load=321, voltage_battery=9550, current_battery=-1, battery_remaining=0, drop_rate_comm=25))
        result = self.registry.snapshot(True)
        states = {h['label']: h['state'] for h in result['health']}
        self.assertEqual(states['陀螺仪'], '正常')
        self.assertEqual(states['加速度计'], '异常 / 未通过')
        self.assertEqual(states['磁力计'], '未启用')
        self.assertEqual(states['GPS'], '未安装 / 未报告')
        self.assertAlmostEqual(self.metrics()['cpuLoad']['value'], 32.1)
        self.assertIsNone(self.metrics()['systemCurrent']['value'])
        self.assertEqual(self.metrics()['systemBatteryRemaining']['value'], 0)
        self.assertEqual(self.registry.snapshot(False)['health'], [])
        self.now += 3.1
        self.assertEqual(self.registry.snapshot(True)['health'], [])

    def test_retained_health_header_cannot_become_new_by_reception(self):
        for sec in (900, 0, 1001):
            self.registry.observe('/mavros/sys_status', NS(header=NS(stamp=NS(sec=sec, nanosec=0)), sensors_present=7, sensors_enabled=7, sensors_health=7, load=100))
            result = self.registry.snapshot(True)
            self.assertEqual(result['health'], [])
            self.assertIsNone(result['extra_metrics']['cpuLoad']['value'])
            source = next(s for s in result['telemetry_sources'] if s['topic'] == '/mavros/sys_status')
            self.assertEqual(source['received_age_s'], 0)
            self.assertIn(source['status'], ('STALE', 'INVALID'))
            self.assertIsNotNone(source['data'], '缓存仅保留诊断，不伪装最新自检')

    def test_estimator_flags_are_preserved_as_flags_not_all_good_health(self):
        flags = {key: False for key in ESTIMATOR_FLAGS}
        flags['attitude_status_flag'] = True
        flags['gps_glitch_status_flag'] = True
        self.registry.observe('/mavros/estimator_status', NS(**flags))
        self.assertEqual(self.metrics()['ekfFlags']['value'], 1025)
        self.assertEqual(self.registry.snapshot(True)['health'], [])

    def test_target_ignore_masks_and_range_limits_are_respected(self):
        self.registry.observe('/mavros/setpoint_raw/target_local', NS(type_mask=8|2048, coordinate_frame=1,
            position=vec(1, 2, 3), velocity=vec(4, 5, 6), acceleration_or_force=vec(), yaw=0, yaw_rate=0.2))
        values = self.metrics()
        self.assertIsNone(values['targetLocalVelocityX']['value'])
        self.assertEqual(values['targetLocalVelocityY']['value'], 5)
        self.assertIsNone(values['targetLocalYawRate']['value'])
        self.registry.observe('/mavros/optical_flow/ground_distance', NS(range=100, min_range=0.1, max_range=5))
        self.assertIsNone(self.metrics()['opticalFlowRange']['value'])

    def test_alerts_are_bounded_and_expire_without_refreshed_timestamp(self):
        for i in range(40):
            self.registry.observe('/mavros/statustext/recv', NS(severity=b'\x04', text='x'*600 + str(i)))
        result = self.registry.snapshot(True)
        self.assertEqual(len(result['alerts']), 32)
        self.assertEqual(len(result['alerts'][0]['text']), 512)
        self.assertEqual(result['alerts'][0]['severity'], 4)
        self.now += 30.1
        self.assertEqual(self.registry.snapshot(True)['alerts'], [])

    def test_diagnostics_are_bounded_finite_and_cannot_extend_metric_validity(self):
        huge = {'text': 'x'*10000, 'array': [float('nan')]*10000, 'nested': {'a': {'b': {'c': {'d': {'e': {'f': {'g': 1}}}}}}}}
        result = bounded_json(huge)
        self.assertEqual(len(result['text']), 512)
        self.assertEqual(len(result['array']), 32)
        json.dumps(result, allow_nan=False)
        self.registry.observe('/diagnostics', huge)
        self.assertEqual(self.metrics()['batteryCurrent']['reason'], 'NO_SAMPLE')
        json.dumps(self.registry.snapshot(True), allow_nan=False)

    def test_remapped_existing_topic_is_reported_under_actual_name(self):
        self.registry.remap('/landing/action/status', '/custom/executor')
        self.registry.observe('/landing/action/status', NS(data='{"state":"IDLE"}'))
        source = next(s for s in self.registry.snapshot(True)['telemetry_sources'] if s['topic'] == '/custom/executor')
        self.assertEqual(source['count'], 1)
        self.assertEqual(source['status'], 'RECEIVING')

    def test_subscription_qos_is_targeted_and_optional_type_failure_is_isolated(self):
        modules = {name: types.ModuleType(name) for name in ['rosidl_runtime_py', 'rosidl_runtime_py.utilities', 'rclpy', 'rclpy.qos']}
        def load(name):
            if name == 'mavros_msgs/msg/ESCInfo':
                raise RuntimeError('optional type support unavailable')
            return object
        modules['rosidl_runtime_py.utilities'].get_message = load
        qos = modules['rclpy.qos']
        qos.qos_profile_sensor_data = 'sensor-data'
        qos.QoSProfile = lambda **kw: NS(**kw)
        qos.ReliabilityPolicy = NS(RELIABLE='reliable')
        qos.DurabilityPolicy = NS(TRANSIENT_LOCAL='transient-local')
        calls = []
        class Node:
            def create_subscription(self, message_type, topic, callback, profile):
                calls.append((topic, profile))
                return object()
        with patch.dict(sys.modules, modules):
            self.registry.subscribe(Node())
        topics = [topic for topic, _ in calls]
        self.assertEqual(len(topics), len(set(topics)))
        self.assertNotIn('/mavros/battery', topics, '旧回调不能被再次订阅')
        self.assertNotIn('/mavros/imu/data', topics)
        self.assertEqual(dict(calls)['/mavros/home_position/home'].durability, 'transient-local')
        self.assertEqual(dict(calls)['/mavros/sys_status'].durability, 'transient-local')
        self.assertEqual(dict(calls)['/mavros/global_position/global'], 'sensor-data')
        source = next(s for s in self.registry.snapshot(True)['telemetry_sources'] if s['topic'] == '/mavros/esc_status/info')
        self.assertEqual(source['status'], 'UNSUPPORTED_TYPE')


if __name__ == '__main__':
    unittest.main()
