"""Pure state/callback tests; ROS imports are stubs, no device/control is used."""
import importlib.util
import json
import math
from pathlib import Path
import sys
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
    "sensor_msgs.msg": module("sensor_msgs.msg", Range=object, BatteryState=object),
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
        self.state.vehicle_received_s = time.monotonic() - 2
        result = self.state.snapshot()
        self.assertIsNone(result["telemetry"]["battery_voltage_v"])
        self.assertFalse(result["flight_controller_connected"])

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


if __name__ == "__main__":
    unittest.main()
