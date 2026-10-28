"""Pure state/callback tests; ROS imports are stubs, no device/control is used."""
import importlib.util
import gzip
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import math
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch


def module(name, **members):
    result = types.ModuleType(name)
    result.__dict__.update(members)
    return result


stub_modules = {
    "rclpy": module("rclpy"),
    "rclpy.node": module("rclpy.node", Node=object),
    "rclpy.qos": module("rclpy.qos", DurabilityPolicy=object, QoSProfile=object,
                        ReliabilityPolicy=object, qos_profile_sensor_data=object()),
    "geometry_msgs": module("geometry_msgs"),
    "geometry_msgs.msg": module("geometry_msgs.msg", PoseStamped=object, TwistStamped=object),
    "mavros_msgs": module("mavros_msgs"),
    "mavros_msgs.msg": module("mavros_msgs.msg",
        ExtendedState=types.SimpleNamespace(LANDED_STATE_UNDEFINED=0, LANDED_STATE_ON_GROUND=1,
            LANDED_STATE_IN_AIR=2, LANDED_STATE_TAKEOFF=3, LANDED_STATE_LANDING=4),
        PositionTarget=types.SimpleNamespace(IGNORE_YAW_RATE=2048), RCIn=object, State=object,
        VfrHud=object),
    "std_msgs": module("std_msgs"),
    "std_msgs.msg": module("std_msgs.msg", String=object, Float64=object),
    "sensor_msgs": module("sensor_msgs"),
    "sensor_msgs.msg": module("sensor_msgs.msg", Range=object, BatteryState=object, Imu=object),
}
spec = importlib.util.spec_from_file_location("flight_status_bridge_under_test",
    Path(__file__).with_name("flight_status_http.py"))
bridge = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, stub_modules):
    spec.loader.exec_module(bridge)


class TelemetryBridgeTests(unittest.TestCase):
    def setUp(self):
        self.state = bridge.FlightStatusState(0.05)
        self.node = bridge.FlightStatusHttp.__new__(bridge.FlightStatusHttp)
        self.node.state = self.state
        self.state.vehicle.update(connected=True)
        self.state.vehicle_received_s = time.monotonic()

    def battery(self, voltage=15.3, percentage=0.72, present=True):
        self.node._battery(types.SimpleNamespace(voltage=voltage, percentage=percentage, present=present))
        return self.state.snapshot()

    def test_empty_state_does_not_invent_samples(self):
        result = self.state.snapshot()
        for key in ("battery_voltage_v", "battery_remaining_pct", "relative_altitude_m", "rangefinder_m"):
            self.assertIsNone(result["telemetry"][key])
            self.assertFalse(result["telemetry_meta"][key]["valid"])
        json.dumps(result, allow_nan=False)

    def test_reported_voltage_and_fraction_convert_exactly(self):
        result = self.battery()
        self.assertEqual(result["telemetry"]["battery_voltage_v"], 15.3)
        self.assertEqual(result["telemetry"]["battery_remaining_pct"], 72.0)
        self.assertEqual(result["telemetry_meta"]["battery_voltage_v"]["unit"], "V")
        self.assertEqual(result["telemetry_meta"]["battery_remaining_pct"]["source"], "/mavros/battery.percentage")

    def test_unknown_percentage_is_not_estimated_from_voltage(self):
        for value in (float("nan"), float("inf"), -1.0, 72.0, True):
            result = self.battery(percentage=value)
            self.assertEqual(result["telemetry"]["battery_voltage_v"], 15.3)
            self.assertIsNone(result["telemetry"]["battery_remaining_pct"])
            self.assertEqual(result["telemetry_meta"]["battery_remaining_pct"]["reason"], "INVALID_OR_UNREPORTED")
            json.dumps(result, allow_nan=False)

    def test_percentage_zero_is_valid(self):
        result = self.battery(percentage=0.0)
        self.assertEqual(result["telemetry"]["battery_remaining_pct"], 0.0)
        self.assertTrue(result["telemetry_meta"]["battery_remaining_pct"]["valid"])

    def test_absent_battery_hides_values(self):
        result = self.battery(present=False)
        self.assertIsNone(result["telemetry"]["battery_voltage_v"])
        self.assertIsNone(result["telemetry"]["battery_remaining_pct"])

    def test_voltage_zero_negative_and_nan_are_invalid(self):
        for value in (0.0, -1.0, float("nan"), float("inf")):
            self.assertIsNone(self.battery(voltage=value)["telemetry"]["battery_voltage_v"])

    def test_stale_samples_hide_and_refresh_restores(self):
        self.battery()
        self.state.battery_received_s = time.monotonic() - 4
        result = self.state.snapshot()
        self.assertIsNone(result["telemetry"]["battery_voltage_v"])
        self.assertEqual(result["telemetry_meta"]["battery_voltage_v"]["reason"], "STALE")
        self.assertIsNotNone(self.battery()["telemetry"]["battery_voltage_v"])

    def test_disconnected_controller_hides_even_fresh_values(self):
        self.battery()
        self.node._relative_altitude(types.SimpleNamespace(data=2.5))
        self.state.vehicle["connected"] = False
        result = self.state.snapshot()
        self.assertFalse(result["flight_controller_connected"])
        for key in ("battery_voltage_v", "battery_remaining_pct", "relative_altitude_m"):
            self.assertIsNone(result["telemetry"][key])
            self.assertEqual(result["telemetry_meta"][key]["reason"], "FLIGHT_CONTROLLER_DISCONNECTED")

    def test_stale_vehicle_state_gates_all_values(self):
        self.battery()
        self.state.vehicle_received_s = time.monotonic() - 4
        result = self.state.snapshot()
        self.assertIsNone(result["telemetry"]["battery_voltage_v"])
        self.assertFalse(result["flight_controller_connected"])

    def imu(self, orientation_cov=0, gyro_cov=0):
        vector = lambda x, y, z: types.SimpleNamespace(x=x, y=y, z=z)
        self.node._imu(types.SimpleNamespace(
            orientation=types.SimpleNamespace(x=0, y=0, z=0, w=1),
            orientation_covariance=[orientation_cov] * 9,
            angular_velocity=vector(0.001, -0.002, 0.0), angular_velocity_covariance=[gyro_cov] * 9,
            linear_acceleration=vector(0.1, -0.1, 9.8), linear_acceleration_covariance=[0] * 9))
        return self.state.snapshot()

    def test_imu_without_position_does_not_invent_position_or_command_frame(self):
        self.state.vehicle['mode'] = 'GUIDED'
        self.state.command = {'coordinate_frame': 1, 'type_mask': 0, 'velocity': {'x': 1, 'y': 0, 'z': 0}, 'yaw_rate': 0}
        self.state.command_received_s = time.monotonic()
        result = self.imu()
        self.assertEqual(result['telemetry']['roll_deg'], 0)
        self.assertEqual(result['telemetry']['gyro_y'], -0.002)
        self.assertEqual(result['telemetry']['accel_z'], 9.8)
        self.assertIn('/mavros/imu/data', result['telemetry_meta']['roll_deg']['source'])
        self.assertIsNone(result['telemetry']['estimated_altitude_m'])
        self.assertIsNone(result['motion_command']['body_velocity_mps'])

    def test_imu_covariance_and_expiry_are_independent(self):
        result = self.imu(orientation_cov=-1)
        self.assertIsNone(result['telemetry']['roll_deg'])
        self.assertEqual(result['telemetry']['gyro_x'], 0.001)
        result = self.imu(gyro_cov=-1)
        self.assertEqual(result['telemetry']['roll_deg'], 0)
        self.assertIsNone(result['telemetry']['gyro_x'])
        self.state.imu_received_s = time.monotonic() - 0.6
        result = self.state.snapshot()
        for key in ('roll_deg', 'gyro_x', 'accel_z'):
            self.assertIsNone(result['telemetry'][key])

    def test_imu_falls_back_to_pose_only_when_pose_is_valid(self):
        self.state.pose_quaternion = (0, 0, 0, 1)
        self.state.pose_received_s = time.monotonic()
        result = self.imu(orientation_cov=-1)
        self.assertEqual(result['telemetry']['roll_deg'], 0)
        self.assertIn('local_position', result['telemetry_meta']['roll_deg']['source'])
        self.state.pose_received_s -= 1
        self.assertIsNone(self.state.snapshot()['telemetry']['roll_deg'])

    def test_heading_rejects_invalid_values_and_expires(self):
        for value in (None, True, float('nan'), -1, 360):
            self.node._heading(types.SimpleNamespace(data=value))
            self.assertIsNone(self.state.snapshot()['telemetry']['heading_deg'])
        self.node._heading(types.SimpleNamespace(data=306.2))
        self.assertEqual(self.state.snapshot()['telemetry']['heading_deg'], 306.2)
        self.state.heading_received_s -= 1
        self.assertIsNone(self.state.snapshot()['telemetry']['heading_deg'])

    def test_display_tolerates_heartbeat_jitter_without_relaxing_commands(self):
        self.battery()
        self.imu()
        self.state.vehicle['mode'] = 'GUIDED'
        self.state.vehicle_received_s = time.monotonic() - 1.2
        self.state.command = {'coordinate_frame': 8, 'type_mask': 0, 'velocity': {'x': 1, 'y': 0, 'z': 0}, 'yaw_rate': 0}
        self.state.command_received_s = time.monotonic()
        result = self.state.snapshot()
        self.assertEqual(result['telemetry']['roll_deg'], 0)
        self.assertEqual(result['telemetry']['battery_voltage_v'], 15.3)
        self.assertIsNone(result['motion_command']['body_velocity_mps'])
        self.state.vehicle_received_s -= 1
        result = self.state.snapshot()
        self.assertTrue(result['flight_controller_connected'])
        self.assertIsNone(result['telemetry']['roll_deg'])
        self.state.vehicle['connected'] = False
        self.assertIsNone(self.state.snapshot()['telemetry']['gyro_x'])

    def test_relative_altitude_is_independent_of_local_pose_and_range(self):
        self.node._relative_altitude(types.SimpleNamespace(data=-0.4))
        self.state.pose_altitude_m = 1.8
        self.state.pose_received_s = time.monotonic()
        self.state.rangefinder_m = 0.9
        self.state.rangefinder_received_s = time.monotonic()
        result = self.state.snapshot()
        self.assertEqual(result["telemetry"]["relative_altitude_m"], -0.4)
        self.assertEqual(result["telemetry"]["estimated_altitude_m"], 1.8)
        self.assertEqual(result["telemetry"]["rangefinder_m"], 0.9)
        self.node._relative_altitude(types.SimpleNamespace(data=float("nan")))
        self.assertIsNone(self.state.snapshot()["telemetry"]["relative_altitude_m"])

    def test_invalid_range_message_is_not_replaced_by_other_height(self):
        self.node._rangefinder(types.SimpleNamespace(range=float("nan"), min_range=0.02, max_range=12.0))
        self.node._relative_altitude(types.SimpleNamespace(data=1.6))
        result = self.state.snapshot()
        self.assertIsNone(result["telemetry"]["rangefinder_m"])
        self.assertEqual(result["telemetry"]["relative_altitude_m"], 1.6)
        self.assertFalse(result["telemetry_meta"]["rangefinder_m"]["valid"])

    def test_history_uses_same_filtered_values(self):
        self.battery()
        self.state.record_history()
        history = self.state.history_snapshot()
        self.assertEqual(history["samples"][0]["battery_remaining_pct"], 72.0)
        self.state.vehicle["connected"] = False
        self.state.record_history()
        self.assertIsNone(self.state.history_snapshot()["samples"][-1]["battery_remaining_pct"])
        json.dumps(self.state.history_snapshot(), allow_nan=False)

    def test_attitude_signs_and_yaw_independence(self):
        # Build ENU/FLU quaternions from the expected aviation FRD angles.
        for roll, pitch, yaw in [(0, 0, 0), (30, 15, 170), (-42, -20, -85), (0, 89.9, 0)]:
            cr, sr = math.cos(math.radians(roll)/2), math.sin(math.radians(roll)/2)
            cp, sp = math.cos(math.radians(-pitch)/2), math.sin(math.radians(-pitch)/2)
            cy, sy = math.cos(math.radians(yaw)/2), math.sin(math.radians(yaw)/2)
            quaternion = (sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy,
                          cr*cp*sy-sr*sp*cy, cr*cp*cy+sr*sp*sy)
            actual = bridge.attitude_degrees(tuple(value * 2 for value in quaternion))
            self.assertAlmostEqual(actual[0], roll, places=5)
            self.assertAlmostEqual(actual[1], pitch, places=5)
        # At exactly +/-90 pitch, Euler roll/yaw are not separately defined.
        for sign in (-1, 1):
            boundary = bridge.attitude_degrees((0, sign*math.sqrt(0.5), 0, math.sqrt(0.5)))
            self.assertAlmostEqual(boundary[1], -sign*90, places=5)

    def test_attitude_invalid_quaternions_are_not_level(self):
        for quaternion in [None, (0, 0, 0), (0, 0, 0, 0), (True, 0, 0, 1),
                           (float('nan'), 0, 0, 1), (0, float('inf'), 0, 1), (1e308,)*4]:
            self.assertIsNone(bridge.attitude_degrees(quaternion))

    def test_pose_attitude_callback_freshness_and_disconnect(self):
        q = types.SimpleNamespace(x=0, y=0, z=0, w=1)
        self.node._pose(types.SimpleNamespace(pose=types.SimpleNamespace(
            position=types.SimpleNamespace(z=3.5), orientation=q)))
        result = self.state.snapshot()
        self.assertEqual(result['telemetry']['roll_deg'], 0)
        self.assertEqual(result['telemetry']['pitch_deg'], 0)
        self.assertEqual(result['telemetry']['estimated_altitude_m'], 3.5)
        self.state.pose_received_s = time.monotonic() - 0.6
        result = self.state.snapshot()
        self.assertIsNone(result['telemetry']['roll_deg'])
        self.assertEqual(result['telemetry_meta']['pitch_deg']['reason'], 'STALE')
        self.assertEqual(result['telemetry']['estimated_altitude_m'], 3.5)
        self.state.pose_received_s = time.monotonic()
        self.state.vehicle['connected'] = False
        result = self.state.snapshot()
        self.assertIsNone(result['telemetry']['pitch_deg'])
        self.assertEqual(result['telemetry_meta']['roll_deg']['reason'], 'FLIGHT_CONTROLLER_DISCONNECTED')
        json.dumps(result, allow_nan=False)


class TelemetryHttpCompressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = bridge.FlightStatusState(0.05).snapshot()
        cls.payload['precision_probe'] = -1.09876543210987
        cls.history = {'samples': [cls.payload], 'sample_period_s': 1}
        class Handler(bridge.FlightStatusHandler):
            state = types.SimpleNamespace(snapshot=lambda: cls.payload, history_snapshot=lambda: cls.history)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, encoding=None, path='/api/status'):
        connection = HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.putrequest('GET', path, skip_accept_encoding=True)
            if encoding is not None:
                connection.putheader('Accept-Encoding', encoding)
            connection.endheaders()
            response = connection.getresponse()
            payload = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Vary'), 'Accept-Encoding')
            self.assertEqual(int(response.getheader('Content-Length')), len(payload))
            return response.getheader('Content-Encoding'), payload
        finally:
            connection.close()

    def test_explicit_gzip_quality_round_trip_keeps_every_field_and_precision(self):
        for encoding in ('gzip', 'br, gzip;q=0.5', 'GZIP ; q = 1'):
            with self.subTest(encoding=encoding):
                content_encoding, payload = self.request(encoding)
                self.assertEqual(content_encoding, 'gzip')
                uncompressed = gzip.decompress(payload)
                self.assertEqual(json.loads(uncompressed), self.payload)
                self.assertLess(len(payload), len(uncompressed) / 10)

    def test_q_zero_absent_or_unsupported_encoding_keeps_original_json(self):
        for encoding in (None, 'identity', '*', 'br', 'gzip;q=0', 'gzip;q=0.0, br', 'gzip;q=no', 'gzip;q=2', 'gzip;q=nan'):
            with self.subTest(encoding=encoding):
                content_encoding, payload = self.request(encoding)
                self.assertIsNone(content_encoding)
                self.assertEqual(json.loads(payload), self.payload)

    def test_history_endpoint_has_the_same_lossless_negotiation(self):
        content_encoding, payload = self.request('gzip', '/api/history?test=1')
        self.assertEqual(content_encoding, 'gzip')
        self.assertEqual(json.loads(gzip.decompress(payload)), self.history)


if __name__ == "__main__":
    unittest.main()
